// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface ICollateralVault {
    function releaseCollateral(uint256 loanId, address payable recipient) external;
    function liquidateCollateral(uint256 loanId, address payable recipient, uint256 seizeAmount) external;
}

interface ILoanFactory {
    function demoMode() external view returns (bool);
}

interface IPriceFeed {
    /// @return ETH/USD price in whole dollars (e.g. 2000 for $2,000).
    function latestPrice() external view returns (uint256);
}

/// @title Loan — one contract per borrow request, escrow and enforcer for its whole lifecycle
/// @notice Deployed by LoanFactory once the borrower's collateral is in the vault.
///         Terms (principal, duration, interest, LTV, buffer) are fixed at construction
///         and never renegotiated; everything this contract does afterwards is a
///         consequence of those numbers plus time and the oracle price.
contract Loan is ReentrancyGuard {
    using Address for address payable;

    // How long a request stays open before it can no longer be funded. Bounds how
    // long the borrower's collateral can sit locked against a request nobody took.
    uint256 public constant FUNDING_WINDOW = 7 days;

    // Grace period after the repayment deadline before a lender may liquidate.
    uint256 public constant GRACE_PERIOD = 2 days;

    enum LoanStatus {
        Requested,
        Funded,
        Repaid,
        Cancelled,
        Liquidated
    }

    uint256 public immutable loanId;
    address public immutable factory;
    address public immutable borrower;
    address public lender;
    address public immutable collateralVault;

    uint256 public immutable principalAmount;
    uint256 public immutable collateralAmount;
    uint256 public immutable durationDays;
    uint256 public immutable interestBps;
    uint256 public immutable maxLtvBps;
    uint256 public immutable liquidationBufferBps;
    // Not immutable, unlike the terms above: fastForward() rewinds these to simulate
    // elapsed time. On a production deployment (demoMode false) they are write-once.
    uint256 public requestedAt;
    uint256 public fundedAt;

    /// Oracle used to value collateral in USD. May be address(0), in which case
    /// price-based liquidation is simply disabled and only the repayment
    /// deadline can trigger liquidation.
    address public immutable priceFeed;

    // --- Price-based liquidation state -------------------------------------
    //
    // Collateral and principal are both denominated in ETH, so principal/collateral
    // is a constant ratio that an ETH price move cannot change. To make the oracle
    // economically meaningful, the debt is frozen in USD at funding time:
    //
    //   debtValueUsd     = principalAmount x price AT FUNDING      (fixed)
    //   collateralValue  = collateralAmount x price NOW            (floats)
    //   LTV              = debtValueUsd / collateralValueUsd
    //
    // So if ETH falls, the collateral securing the loan is worth less against a
    // fixed USD debt, LTV climbs, and the position becomes liquidatable — which
    // is exactly the worked example in the project brief ($1,400 debt against
    // $2,000 collateral liquidating once collateral falls to $1,750).
    //
    // Both values carry units of wei x USD; the ratio is dimensionless, so no
    // rescaling is needed. Settlement stays ETH-denominated (see repay()) —
    // the USD figure exists to measure the lender's exposure, not to restate
    // what the borrower owes.
    uint256 public debtValueUsd;
    /// ETH/USD price recorded at funding, for transparency in the UI. 0 if no oracle.
    uint256 public priceAtFunding;

    // Cumulative wei applied toward totalRepaymentDue() so far. Repayment is a
    // lump sum against the live outstanding balance (no principal/interest split,
    // no amortization) — interest keeps accruing on the full original
    // principalAmount, capped once the loan becomes liquidatable (see
    // interestDue()). This is a deliberate simplification for the MVP.
    uint256 public amountRepaid;

    // block.timestamp when status became Repaid or Liquidated; 0 until then.
    // Freezes interest accrual so a closed loan's outstanding balance stays 0.
    uint256 public closedAt;

    LoanStatus public status;

    event LoanFunded(uint256 indexed loanId, address indexed lender, uint256 amount);
    event LoanRepaid(uint256 indexed loanId, address indexed borrower, uint256 repaymentAmount);
    event PartialRepayment(
        uint256 indexed loanId,
        address indexed payer,
        uint256 amountApplied,
        uint256 totalRepaidSoFar,
        uint256 remainingOwed
    );
    event LoanCancelled(uint256 indexed loanId);
    event LoanLiquidated(
        uint256 indexed loanId,
        address indexed lender,
        uint256 seizedAmount,
        uint256 refundedToBorrower
    );
    event DemoTimeSkipped(uint256 indexed loanId, address indexed by, uint256 secondsSkipped);

    modifier onlyBorrower() {
        require(msg.sender == borrower, "Loan: caller is not borrower");
        _;
    }

    modifier onlyLender() {
        require(msg.sender == lender, "Loan: caller is not lender");
        _;
    }

    /// @notice Records the agreed terms and opens the request for funding.
    /// @dev Called only by LoanFactory.createLoan(), after the collateral has been
    ///      taken from the borrower but before it reaches the vault. The collateral
    ///      amount is passed in rather than held here — this contract never custodies
    ///      collateral, it only instructs the vault.
    /// @param loanId_ Factory-assigned id; also the vault's key for this position.
    /// @param factory_ Deploying factory, read back later for the demoMode flag.
    /// @param borrower_ Owner of the collateral and the only address that may repay or cancel.
    /// @param principalAmount_ Exact wei a lender must send to fund().
    /// @param collateralAmount_ Wei of collateral held in the vault against this loan.
    /// @param durationDays_ Agreed term, used to derive the repayment deadline.
    /// @param interestBps_ Annualised rate in bps; accrual is continuous, not per-term.
    /// @param maxLtvBps_ Tier's maximum LTV, the base of the liquidation threshold.
    /// @param liquidationBufferBps_ Headroom added to maxLtv before liquidation opens.
    /// @param collateralVault_ Vault holding the collateral for this loanId.
    /// @param priceFeed_ Oracle, or address(0) to run deadline-only.
    /// Reverts on a zero factory, borrower or vault, zero principal, collateral or
    /// duration, or an LTV outside (0, 10000].
    constructor(
        uint256 loanId_,
        address factory_,
        address borrower_,
        uint256 principalAmount_,
        uint256 collateralAmount_,
        uint256 durationDays_,
        uint256 interestBps_,
        uint256 maxLtvBps_,
        uint256 liquidationBufferBps_,
        address collateralVault_,
        address priceFeed_
    ) {
        require(factory_ != address(0), "Loan: factory is zero address");
        require(borrower_ != address(0), "Loan: borrower is zero address");
        require(principalAmount_ > 0, "Loan: principal required");
        require(collateralAmount_ > 0, "Loan: collateral required");
        require(durationDays_ > 0, "Loan: duration required");
        require(maxLtvBps_ > 0 && maxLtvBps_ <= 10_000, "Loan: invalid LTV");
        require(collateralVault_ != address(0), "Loan: vault is zero address");

        loanId = loanId_;
        factory = factory_;
        borrower = borrower_;
        principalAmount = principalAmount_;
        collateralAmount = collateralAmount_;
        durationDays = durationDays_;
        interestBps = interestBps_;
        maxLtvBps = maxLtvBps_;
        liquidationBufferBps = liquidationBufferBps_;
        collateralVault = collateralVault_;
        priceFeed = priceFeed_; // address(0) allowed — disables price-based liquidation
        requestedAt = block.timestamp;
        status = LoanStatus.Requested;
    }

    /// @notice Fund the request in full and send the principal straight to the borrower.
    /// @dev Single lender, exact amount, no partial fills — the debt figures below all
    ///      assume the whole principal moved in one transaction. Reverts unless the
    ///      loan is still Requested, the funding window is open, the caller is not the
    ///      borrower, and msg.value equals principalAmount exactly.
    function fund() external payable nonReentrant {
        require(status == LoanStatus.Requested, "Loan: not fundable");
        require(block.timestamp <= requestedAt + FUNDING_WINDOW, "Loan: funding window has expired");
        require(msg.sender != borrower, "Loan: borrower cannot fund");
        require(msg.value == principalAmount, "Loan: exact principal required");

        lender = msg.sender;
        fundedAt = block.timestamp;
        status = LoanStatus.Funded;

        // Freeze the USD value of the debt at funding. If the oracle is absent
        // or unhealthy this stays 0, which disables price-based liquidation for
        // this loan rather than letting bad data seize someone's collateral.
        uint256 price = _readPrice();
        if (price > 0) {
            priceAtFunding = price;
            debtValueUsd = principalAmount * price;
        }

        payable(borrower).sendValue(msg.value);
        emit LoanFunded(loanId, msg.sender, msg.value);
    }

    /// @notice Pay any amount toward the outstanding balance; overpayment is refunded.
    /// @dev Partial payments are supported: any call may pay less than the full
    ///      outstanding balance. Each payment is forwarded to the lender immediately
    ///      (no escrow), matching this contract's existing instant-settlement pattern.
    ///      The loan only transitions to Repaid — releasing collateral — once
    ///      amountRepaid reaches the live outstandingBalance().
    ///      Reverts unless the caller is the borrower, the loan is Funded, msg.value
    ///      is non-zero and something is still owed.
    function repay() external payable onlyBorrower nonReentrant {
        require(status == LoanStatus.Funded, "Loan: not active");
        require(msg.value > 0, "Loan: repayment must be non-zero");

        // Read once and reuse. outstandingBalance() moves with block.timestamp, so
        // recomputing it per use could let the refund, the applied amount and the
        // final-payment test disagree with each other within a single call.
        uint256 owed = outstandingBalance();
        require(owed > 0, "Loan: nothing owed");

        uint256 applied = msg.value > owed ? owed : msg.value;
        uint256 refund = msg.value - applied;
        bool isFinalPayment = (applied == owed);

        // All state settled before any value leaves the contract, so the vault call
        // and the two transfers below cannot re-enter into a stale balance.
        amountRepaid += applied;

        if (isFinalPayment) {
            status = LoanStatus.Repaid;
            closedAt = block.timestamp;
        }

        payable(lender).sendValue(applied);
        if (refund > 0) {
            payable(msg.sender).sendValue(refund);
        }

        if (isFinalPayment) {
            ICollateralVault(collateralVault).releaseCollateral(loanId, payable(borrower));
            emit LoanRepaid(loanId, msg.sender, amountRepaid);
        } else {
            emit PartialRepayment(loanId, msg.sender, applied, amountRepaid, owed - applied);
        }
    }

    /// @notice Withdraw an unfunded request and take the collateral back.
    /// @dev Only valid while Requested; once a lender has funded there is a
    ///      counterparty with a claim, so the exit is repay() or liquidation.
    ///      Reverts unless the caller is the borrower and the loan is still Requested.
    function cancel() external onlyBorrower nonReentrant {
        require(status == LoanStatus.Requested, "Loan: cannot cancel");

        status = LoanStatus.Cancelled;
        ICollateralVault(collateralVault).releaseCollateral(loanId, payable(borrower));
        emit LoanCancelled(loanId);
    }

    /// @notice Demo-only: rewind this loan's clock so time-gated behaviour can be
    ///         exercised immediately instead of waiting real days.
    /// @dev Works by moving the loan's own timestamps *backwards*, which is
    ///      equivalent to moving "now" forwards — block.timestamp itself cannot be
    ///      manipulated on a live network. Affects the funding window while the
    ///      loan is Requested, and the repayment deadline / grace period / interest
    ///      accrual once it is Funded. Restricted to the loan's own participants so
    ///      a stranger cannot force someone else's position into liquidation.
    /// @param secondsToSkip How far to advance the loan's apparent age.
    /// Reverts when the factory has demoMode off, secondsToSkip is 0, the caller is
    /// neither borrower nor lender, or the loan is already closed.
    function fastForward(uint256 secondsToSkip) external {
        require(demoMode(), "Loan: demo mode disabled");
        require(secondsToSkip > 0, "Loan: nothing to skip");
        require(
            msg.sender == borrower || msg.sender == lender,
            "Loan: not a participant"
        );

        // Floored at 0 rather than allowed to underflow, so an oversized skip just
        // pins the loan at maximum age instead of reverting the demo.
        if (status == LoanStatus.Requested) {
            requestedAt = secondsToSkip >= requestedAt ? 0 : requestedAt - secondsToSkip;
        } else if (status == LoanStatus.Funded) {
            fundedAt = secondsToSkip >= fundedAt ? 0 : fundedAt - secondsToSkip;
        } else {
            revert("Loan: loan is closed");
        }

        emit DemoTimeSkipped(loanId, msg.sender, secondsToSkip);
    }

    /// @notice Seize collateral to cover the outstanding debt and refund the surplus.
    /// @dev Real liquidation eligibility. Two independent triggers:
    ///        1. Delinquency — past the repayment deadline plus the grace period.
    ///        2. Collateral shortfall — oracle-priced LTV at or above the liquidation
    ///           threshold (maxLtv + buffer), i.e. an ETH price crash.
    ///      Replaces the old unconditional markLiquidatedForDemo() bypass.
    ///      Only the lender may call: there is no keeper reward, so opening this up
    ///      would let a third party close a position they have no stake in.
    ///      Reverts unless the caller is the lender, the loan is Funded and at least
    ///      one trigger is live.
    function liquidate() external onlyLender nonReentrant {
        require(status == LoanStatus.Funded, "Loan: not active");
        require(
            isDelinquentLiquidatable() || isPriceLiquidatable(),
            "Loan: not liquidatable"
        );

        // Seize only what is actually still owed; the surplus goes back to the
        // borrower. Both the debt and the collateral are ETH-denominated, so no
        // oracle conversion is needed to make the lender whole. Partial
        // repayments therefore shrink the seizure pound for pound.
        uint256 owed = outstandingBalance();
        uint256 seizeAmount = owed < collateralAmount ? owed : collateralAmount;
        uint256 refund = collateralAmount - seizeAmount;

        status = LoanStatus.Liquidated;
        closedAt = block.timestamp;

        ICollateralVault(collateralVault).liquidateCollateral(loanId, payable(lender), seizeAmount);
        emit LoanLiquidated(loanId, msg.sender, seizeAmount, refund);
    }

    /// @notice What a lender would seize right now, and what the borrower would keep.
    /// @dev Lets both sides see the split before anyone clicks Liquidate. Mirrors the
    ///      arithmetic in liquidate() exactly; if the two ever diverge the UI is lying.
    /// @return seizeAmount Wei that would go to the lender.
    /// @return refundAmount Wei that would go back to the borrower.
    function liquidationPreview() external view returns (uint256 seizeAmount, uint256 refundAmount) {
        uint256 owed = outstandingBalance();
        seizeAmount = owed < collateralAmount ? owed : collateralAmount;
        refundAmount = collateralAmount - seizeAmount;
    }

    // Reads the oracle defensively: a missing or reverting feed yields 0 rather
    // than bricking every view that touches price.
    function _readPrice() internal view returns (uint256) {
        if (priceFeed == address(0)) return 0;
        try IPriceFeed(priceFeed).latestPrice() returns (uint256 p) {
            return p;
        } catch {
            return 0;
        }
    }

    /// @notice Whether demo helpers (fastForward) are enabled, per the deploying factory.
    /// @dev Wrapped in try/catch for the same reason as _readPrice: a factory that
    ///      does not answer means demo off, not a revert propagated into fastForward().
    /// @return True when the factory reports demoMode.
    function demoMode() public view returns (bool) {
        try ILoanFactory(factory).demoMode() returns (bool d) {
            return d;
        } catch {
            return false;
        }
    }

    /// @notice Current ETH/USD price from the oracle.
    /// @return Whole dollars, or 0 when unavailable.
    function currentPrice() public view returns (uint256) {
        return _readPrice();
    }

    /// @notice LTV where liquidation becomes available, in bps (maxLtv + buffer).
    /// @return The threshold in basis points.
    function liquidationThresholdBps() public view returns (uint256) {
        return maxLtvBps + liquidationBufferBps;
    }

    /// @notice Live LTV in bps: frozen USD debt over current USD collateral value.
    /// @dev Returns 0 when it cannot be computed (not funded, or no oracle data) —
    ///      callers must treat 0 as "unknown", not as "perfectly healthy".
    /// @return LTV in basis points, or 0 if it cannot be computed.
    function currentLtvBps() public view returns (uint256) {
        if (status != LoanStatus.Funded || debtValueUsd == 0) return 0;
        uint256 price = _readPrice();
        if (price == 0) return 0;
        uint256 collateralValueUsd = collateralAmount * price;
        if (collateralValueUsd == 0) return 0;
        // mulDiv, not (debtValueUsd * 10_000) / collateralValueUsd: both operands are
        // already wei x USD, and the intermediate product would be the thing that
        // overflows. mulDiv carries it at 512 bits and only then divides down.
        return Math.mulDiv(debtValueUsd, 10_000, collateralValueUsd);
    }

    /// @notice True once the collateral no longer covers the debt at the threshold.
    /// @return Whether the price trigger is live.
    function isPriceLiquidatable() public view returns (bool) {
        uint256 ltv = currentLtvBps();
        if (ltv == 0) return false; // unknown price => never liquidate on price
        return ltv >= liquidationThresholdBps();
    }

    /// @notice True once the borrower has missed the deadline and burned the grace period.
    /// @return Whether the delinquency trigger is live.
    function isDelinquentLiquidatable() public view returns (bool) {
        return status == LoanStatus.Funded && block.timestamp > repaymentDueAt() + GRACE_PERIOD;
    }

    // Timestamp up to which interest should accrue: while the loan is Funded,
    // that's "now"; once closed, it's frozen at closedAt so a settled loan's
    // outstanding balance never drifts. Either way, capped at the point the
    // loan becomes liquidatable — delinquency past that point doesn't inflate
    // the debt further, it just means the lender's recourse is to liquidate.
    function _interestAccrualEnd() internal view returns (uint256) {
        uint256 cap = repaymentDueAt() + GRACE_PERIOD;
        uint256 end = status == LoanStatus.Funded ? block.timestamp : (closedAt != 0 ? closedAt : fundedAt);
        return end < cap ? end : cap;
    }

    /// @notice Interest owed as of now (or as of settlement, once closed).
    /// @dev Interest accrues continuously from fundedAt at interestBps, not just over
    ///      the fixed durationDays term — a loan repaid early pays less, one repaid
    ///      late pays more (up to the cap above). At elapsedSeconds == durationDays
    ///      exactly, this is algebraically identical to a fixed-duration calculation.
    /// @return Interest in wei; 0 before funding.
    function interestDue() public view returns (uint256) {
        if (fundedAt == 0) return 0;
        uint256 elapsedSeconds = _interestAccrualEnd() - fundedAt;
        return Math.mulDiv(principalAmount, interestBps * elapsedSeconds, 10_000 * 365 days);
    }

    /// @notice Principal plus accrued interest, ignoring anything already paid.
    /// @dev Live, time-varying figure — the full amount owed as of "now" (or as of
    ///      closedAt for a settled loan). Do not cache; re-query at point of use.
    /// @return Total due in wei.
    function totalRepaymentDue() public view returns (uint256) {
        return principalAmount + interestDue();
    }

    /// @notice What's left to pay right now, after amountRepaid is applied.
    /// @dev Clamped at 0: a final payment lands exactly on the balance, but the
    ///      subtraction is guarded anyway so no view can revert on an underflow.
    /// @return Remaining debt in wei, 0 once settled.
    function outstandingBalance() public view returns (uint256) {
        uint256 due = totalRepaymentDue();
        return due > amountRepaid ? due - amountRepaid : 0;
    }

    /// @notice Timestamp the borrower must have repaid by.
    /// @dev Fixed repayment deadline, derived from the agreed durationDays. Only
    ///      meaningful once funded (status == Funded implies fundedAt != 0).
    /// @return Unix timestamp of the deadline.
    function repaymentDueAt() public view returns (uint256) {
        return fundedAt + (durationDays * 1 days);
    }

    /// @notice Past the deadline but not yet liquidatable — informational for the UI.
    /// @return Whether the loan is late but still inside the grace period.
    function isDelinquent() public view returns (bool) {
        return status == LoanStatus.Funded && block.timestamp > repaymentDueAt();
    }

    /// @notice Whether liquidate() would succeed right now.
    /// @dev The exact condition liquidate() enforces — safe for the frontend to poll.
    ///      Use isDelinquentLiquidatable() / isPriceLiquidatable() to tell the user *why*.
    /// @return Whether either trigger is live.
    function isLiquidatable() public view returns (bool) {
        return isDelinquentLiquidatable() || isPriceLiquidatable();
    }
}
