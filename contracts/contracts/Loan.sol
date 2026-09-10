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

    // Bounds every distribution loop's gas. Small by design: a pool of a few
    // teammates, not an open crowd sale.
    uint256 public constant MAX_LENDERS = 10;

    // Gas forwarded on push transfers. Enough for an EOA or a simple contract
    // wallet receive; a recipient that needs more gets credited for pull
    // withdrawal instead of blocking everyone else.
    uint256 internal constant PUSH_GAS_LIMIT = 50_000;

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

    // --- Multi-lender pool state -------------------------------------------
    //
    // Contributions escrow in this contract while the loan is Requested. The
    // borrower is paid only when the pool fills. contributions[] is the source
    // of truth for membership; _lenders may retain reclaimed addresses whose
    // contribution has returned to zero (distribution loops skip them because
    // a zero contribution produces a zero share, and reclaim is only possible
    // before funding while distribution only happens after).
    address[] private _lenders;
    mapping(address => uint256) public contributions;
    uint256 public totalContributed;
    // Failed push transfers accumulate here for pull withdrawal.
    mapping(address => uint256) public pendingWithdrawals;

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
    // fixed USD debt, LTV climbs, and the position becomes liquidatable - which
    // is exactly the worked example in the project brief ($1,400 debt against
    // $2,000 collateral liquidating once collateral falls to $1,750).
    //
    // Both values carry units of wei x USD; the ratio is dimensionless, so no
    // rescaling is needed. Settlement stays ETH-denominated (see repay()) -
    // the USD figure exists to measure the lender's exposure, not to restate
    // what the borrower owes.
    uint256 public debtValueUsd;
    /// ETH/USD price recorded at funding, for transparency in the UI. 0 if no oracle.
    uint256 public priceAtFunding;

    // Cumulative wei applied toward totalRepaymentDue() so far. Repayment is a
    // lump sum against the live outstanding balance (no principal/interest split,
    // no amortization) - interest keeps accruing on the full original
    // principalAmount, capped once the loan becomes liquidatable (see
    // interestDue()). This is a deliberate simplification for the MVP.
    uint256 public amountRepaid;

    // block.timestamp when status became Repaid or Liquidated; 0 until then.
    // Freezes interest accrual so a closed loan's outstanding balance stays 0.
    uint256 public closedAt;

    LoanStatus public status;

    event Contribution(uint256 indexed loanId, address indexed contributor, uint256 amount, uint256 totalContributed);
    event LoanFunded(uint256 indexed loanId, uint256 totalContributed);
    event ShareDistributed(uint256 indexed loanId, address indexed lender, uint256 amount, bool pending);
    event Withdrawal(uint256 indexed loanId, address indexed lender, uint256 amount);
    event ContributionReclaimed(uint256 indexed loanId, address indexed contributor, uint256 amount);
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
        priceFeed = priceFeed_; // address(0) allowed - disables price-based liquidation
        requestedAt = block.timestamp;
        status = LoanStatus.Requested;
    }

    /// Seizure proceeds arrive here from the vault during liquidate(); nothing
    /// else may send plain ETH (contributions must go through contribute()).
    receive() external payable {
        require(msg.sender == collateralVault, "Loan: direct transfers not accepted");
    }

    /// 1% of principal, floor 1 wei, applied per call (top-ups included). When
    /// the remaining gap is under the minimum, the closing contributor still
    /// sends at least the minimum and the excess is refunded in the same tx.
    function minContribution() public view returns (uint256) {
        uint256 m = principalAmount / 100;
        return m == 0 ? 1 : m;
    }

    function contribute() external payable nonReentrant {
        require(status == LoanStatus.Requested, "Loan: not fundable");
        require(block.timestamp <= requestedAt + FUNDING_WINDOW, "Loan: funding window has expired");
        require(msg.sender != borrower, "Loan: borrower cannot fund");
        require(msg.value >= minContribution(), "Loan: below minimum contribution");

        if (contributions[msg.sender] == 0) {
            require(_lenders.length < MAX_LENDERS, "Loan: lender cap reached");
            _lenders.push(msg.sender);
        }

        uint256 remaining = principalAmount - totalContributed;
        uint256 accepted = msg.value > remaining ? remaining : msg.value;
        uint256 refund = msg.value - accepted;

        contributions[msg.sender] += accepted;
        totalContributed += accepted;
        emit Contribution(loanId, msg.sender, accepted, totalContributed);

        if (totalContributed == principalAmount) {
            fundedAt = block.timestamp;
            status = LoanStatus.Funded;

            // Freeze the USD value of the debt at funding. If the oracle is
            // absent or unhealthy this stays 0, which disables price-based
            // liquidation for this loan rather than letting bad data seize
            // someone's collateral.
            uint256 price = _readPrice();
            if (price > 0) {
                priceAtFunding = price;
                debtValueUsd = principalAmount * price;
            }

            payable(borrower).sendValue(principalAmount);
            emit LoanFunded(loanId, totalContributed);
        }

        if (refund > 0) {
            payable(msg.sender).sendValue(refund);
        }
    }

    /// Pull-based refund of an escrowed contribution, once the pool can no
    /// longer complete: the borrower cancelled, or the funding window expired
    /// with the loan still Requested. Each contributor reclaims their own.
    function reclaimContribution() external nonReentrant {
        bool expiredWhileRequested =
            status == LoanStatus.Requested && block.timestamp > requestedAt + FUNDING_WINDOW;
        require(status == LoanStatus.Cancelled || expiredWhileRequested, "Loan: nothing to reclaim");

        uint256 amount = contributions[msg.sender];
        require(amount > 0, "Loan: no contribution");

        contributions[msg.sender] = 0;
        totalContributed -= amount;

        payable(msg.sender).sendValue(amount);
        emit ContributionReclaimed(loanId, msg.sender, amount);
    }

    /// Collect shares that could not be pushed (recipient reverted or ran out
    /// of the forwarded gas). Callable in any loan status.
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Loan: nothing to withdraw");

        pendingWithdrawals[msg.sender] = 0;
        payable(msg.sender).sendValue(amount);
        emit Withdrawal(loanId, msg.sender, amount);
    }

    // Partial payments are supported: any call may pay less than the full
    // outstanding balance. Each payment is split pro-rata across contributors
    // immediately (no escrow), matching this contract's existing
    // instant-settlement pattern. The loan only transitions to Repaid -
    // releasing collateral - once amountRepaid reaches the live outstandingBalance().
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

        _distribute(applied);

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
        // Escrowed contributions stay here until each contributor calls
        // reclaimContribution(); status Cancelled is what unlocks it.
    }

    /// @notice Demo-only: rewind this loan's clock so time-gated behaviour can be
    ///         exercised immediately instead of waiting real days.
    /// @dev Works by moving the loan's own timestamps *backwards*, which is
    ///      equivalent to moving "now" forwards - block.timestamp itself cannot be
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

        // Floored at 0 rather than allowed to underflow, so an oversized skip just
        // pins the loan at maximum age instead of reverting the demo.
        if (status == LoanStatus.Requested) {
            // Borrower-only while Requested: a contributor must not be able to
            // rewind the funding window. Otherwise a contributor could put in
            // the 1% minimum, fastForward past FUNDING_WINDOW to expire the
            // loan, then reclaimContribution() in the same block - permanently
            // bricking the pool for every other contributor for the cost of gas.
            require(msg.sender == borrower, "Loan: not a participant");
            requestedAt = secondsToSkip >= requestedAt ? 0 : requestedAt - secondsToSkip;
        } else if (status == LoanStatus.Funded) {
            require(
                msg.sender == borrower || contributions[msg.sender] > 0,
                "Loan: not a participant"
            );
            fundedAt = secondsToSkip >= fundedAt ? 0 : fundedAt - secondsToSkip;
        } else {
            revert("Loan: loan is closed");
        }

        emit DemoTimeSkipped(loanId, msg.sender, secondsToSkip);
    }

    // Real liquidation eligibility. Two independent triggers:
    //   1. Delinquency - past the repayment deadline plus the grace period.
    //   2. Collateral shortfall - oracle-priced LTV at or above the liquidation
    //      threshold (maxLtv + buffer), i.e. an ETH price crash.
    // Replaces the old unconditional markLiquidatedForDemo() bypass.
    //
    /// Any contributor may trigger liquidation; a pool must not depend on one
    /// specific person clicking. Seizure proceeds route through this contract
    /// (see receive()) and are split pro-rata like a repayment.
    function liquidate() external nonReentrant {
        require(contributions[msg.sender] > 0, "Loan: caller is not a lender");
        require(status == LoanStatus.Funded, "Loan: not active");
        require(
            isDelinquentLiquidatable() || isPriceLiquidatable(),
            "Loan: not liquidatable"
        );

        // Seize only what is actually still owed; the surplus goes back to the
        // borrower. Both the debt and the collateral are ETH-denominated, so no
        // oracle conversion is needed to make the lenders whole. Partial
        // repayments therefore shrink the seizure pound for pound.
        uint256 owed = outstandingBalance();
        uint256 seizeAmount = owed < collateralAmount ? owed : collateralAmount;
        uint256 refund = collateralAmount - seizeAmount;

        status = LoanStatus.Liquidated;
        closedAt = block.timestamp;

        ICollateralVault(collateralVault).liquidateCollateral(loanId, payable(address(this)), seizeAmount);
        _distribute(seizeAmount);
        emit LoanLiquidated(loanId, msg.sender, seizeAmount, refund);
    }

    /// What the pool would seize right now, and what the borrower would keep.
    /// Lets both sides see the split before anyone clicks Liquidate.
    function liquidationPreview() external view returns (uint256 seizeAmount, uint256 refundAmount) {
        uint256 owed = outstandingBalance();
        seizeAmount = owed < collateralAmount ? owed : collateralAmount;
        refundAmount = collateralAmount - seizeAmount;
    }

    // --- Distribution internals --------------------------------------------

    /// Split `amount` pro-rata by contribution over principal. The last lender
    /// receives `amount` minus the sum of the earlier floors, so the total
    /// distributed always equals `amount` exactly (rounding dust, a few wei at
    /// most, lands deterministically on the last contributor).
    function _distribute(uint256 amount) internal {
        uint256 n = _lenders.length;
        uint256 distributed = 0;
        for (uint256 i = 0; i < n; i++) {
            address lender_ = _lenders[i];
            uint256 share;
            if (i == n - 1) {
                share = amount - distributed;
            } else {
                share = Math.mulDiv(amount, contributions[lender_], principalAmount);
            }
            distributed += share;
            if (share > 0) {
                _pushOrCredit(lender_, share);
            }
        }
    }

    /// Hybrid settlement: try a gas-capped push; on failure credit the share
    /// for pull withdrawal. A reverting recipient can only hurt itself and can
    /// never block the borrower's repayment or a liquidation.
    function _pushOrCredit(address lender_, uint256 share) internal {
        (bool ok, ) = payable(lender_).call{value: share, gas: PUSH_GAS_LIMIT}("");
        if (ok) {
            emit ShareDistributed(loanId, lender_, share, false);
        } else {
            pendingWithdrawals[lender_] += share;
            emit ShareDistributed(loanId, lender_, share, true);
        }
    }

    // --- Views ---------------------------------------------------------------

    function getLenders() external view returns (address[] memory) {
        return _lenders;
    }

    function fundingProgressBps() external view returns (uint256) {
        return Math.mulDiv(totalContributed, 10_000, principalAmount);
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

    /// Live LTV in bps: frozen USD debt over current USD collateral value.
    /// Returns 0 when it cannot be computed (not funded, or no oracle data) -
    /// callers must treat 0 as "unknown", not as "perfectly healthy".
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
    // loan becomes liquidatable - delinquency past that point doesn't inflate
    // the debt further, it just means the lenders' recourse is to liquidate.
    function _interestAccrualEnd() internal view returns (uint256) {
        uint256 cap = repaymentDueAt() + GRACE_PERIOD;
        uint256 end = status == LoanStatus.Funded ? block.timestamp : (closedAt != 0 ? closedAt : fundedAt);
        return end < cap ? end : cap;
    }

    // Interest accrues continuously from fundedAt at interestBps, not just over
    // the fixed durationDays term - a loan repaid early pays less, one repaid
    // late pays more (up to the cap above). At elapsedSeconds == durationDays
    // exactly, this is algebraically identical to a fixed-duration calculation.
    //
    // BUG-03: this is wei-integer accounting with a single division at the end
    // (mulDiv, not compounded per-second), which is already the maximum
    // precision available without a fixed-point interest unit. For a small
    // enough principal * interestBps * elapsedSeconds product (demo-scale
    // loans checked moments after funding are the practical case - real
    // collateral and multi-day durations don't get near this floor), the true
    // interest owed is under 1 wei and floor-divides to exactly 0. This is an
    // accepted MVP limitation, not a bug to chase further: fixing it for real
    // would mean tracking interest in a higher-precision internal unit (e.g.
    // 1e18-scaled) and only rounding to wei at withdrawal time.
    function interestDue() public view returns (uint256) {
        if (fundedAt == 0) return 0;
        uint256 elapsedSeconds = _interestAccrualEnd() - fundedAt;
        return Math.mulDiv(principalAmount, interestBps * elapsedSeconds, 10_000 * 365 days);
    }

    // Live, time-varying figure - the full amount owed as of "now" (or as of
    // closedAt for a settled loan). Do not cache; re-query at point of use.
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

    // Past the deadline but not yet liquidatable - informational for the UI.
    function isDelinquent() public view returns (bool) {
        return status == LoanStatus.Funded && block.timestamp > repaymentDueAt();
    }

    // The exact condition liquidate() enforces - safe for the frontend to poll.
    // Use isDelinquentLiquidatable() / isPriceLiquidatable() to tell the user *why*.
    function isLiquidatable() public view returns (bool) {
        return isDelinquentLiquidatable() || isPriceLiquidatable();
    }
}
