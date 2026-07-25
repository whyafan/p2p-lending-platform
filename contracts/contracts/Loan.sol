// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface ICollateralVault {
    function releaseCollateral(uint256 loanId, address payable recipient) external;
    function liquidateCollateral(uint256 loanId, address payable recipient) external;
}

contract Loan is ReentrancyGuard {
    using Address for address payable;

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
    uint256 public immutable requestedAt;
    uint256 public fundedAt;

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
    event LoanLiquidated(uint256 indexed loanId, address indexed lender);

    modifier onlyBorrower() {
        require(msg.sender == borrower, "Loan: caller is not borrower");
        _;
    }

    modifier onlyLender() {
        require(msg.sender == lender, "Loan: caller is not lender");
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
        address collateralVault_
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
        requestedAt = block.timestamp;
        status = LoanStatus.Requested;
    }

    function fund() external payable nonReentrant {
        require(status == LoanStatus.Requested, "Loan: not fundable");
        require(block.timestamp <= requestedAt + FUNDING_WINDOW, "Loan: funding window has expired");
        require(msg.sender != borrower, "Loan: borrower cannot fund");
        require(msg.value == principalAmount, "Loan: exact principal required");

        lender = msg.sender;
        fundedAt = block.timestamp;
        status = LoanStatus.Funded;

        payable(borrower).sendValue(msg.value);
        emit LoanFunded(loanId, msg.sender, msg.value);
    }

    // Partial payments are supported: any call may pay less than the full
    // outstanding balance. Each payment is forwarded to the lender immediately
    // (no escrow), matching this contract's existing instant-settlement pattern.
    // The loan only transitions to Repaid — releasing collateral — once
    // amountRepaid reaches the live outstandingBalance().
    function repay() external payable onlyBorrower nonReentrant {
        require(status == LoanStatus.Funded, "Loan: not active");
        require(msg.value > 0, "Loan: repayment must be non-zero");

        uint256 owed = outstandingBalance();
        require(owed > 0, "Loan: nothing owed");

        uint256 applied = msg.value > owed ? owed : msg.value;
        uint256 refund = msg.value - applied;
        bool isFinalPayment = (applied == owed);

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

    function cancel() external onlyBorrower nonReentrant {
        require(status == LoanStatus.Requested, "Loan: cannot cancel");

        status = LoanStatus.Cancelled;
        ICollateralVault(collateralVault).releaseCollateral(loanId, payable(borrower));
        emit LoanCancelled(loanId);
    }

    // Real liquidation eligibility: only callable once the borrower is
    // genuinely delinquent (past the repayment deadline plus a grace period).
    // Replaces the old unconditional markLiquidatedForDemo() bypass.
    function liquidate() external onlyLender nonReentrant {
        require(status == LoanStatus.Funded, "Loan: not active");
        require(block.timestamp > repaymentDueAt() + GRACE_PERIOD, "Loan: grace period not elapsed");

        status = LoanStatus.Liquidated;
        closedAt = block.timestamp;

        ICollateralVault(collateralVault).liquidateCollateral(loanId, payable(lender));
        emit LoanLiquidated(loanId, msg.sender);
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

    // Interest accrues continuously from fundedAt at interestBps, not just over
    // the fixed durationDays term — a loan repaid early pays less, one repaid
    // late pays more (up to the cap above). At elapsedSeconds == durationDays
    // exactly, this is algebraically identical to a fixed-duration calculation.
    function interestDue() public view returns (uint256) {
        if (fundedAt == 0) return 0;
        uint256 elapsedSeconds = _interestAccrualEnd() - fundedAt;
        return Math.mulDiv(principalAmount, interestBps * elapsedSeconds, 10_000 * 365 days);
    }

    // Live, time-varying figure — the full amount owed as of "now" (or as of
    // closedAt for a settled loan). Do not cache; re-query at point of use.
    function totalRepaymentDue() public view returns (uint256) {
        return principalAmount + interestDue();
    }

    // What's left to pay right now, after amountRepaid is applied.
    function outstandingBalance() public view returns (uint256) {
        uint256 due = totalRepaymentDue();
        return due > amountRepaid ? due - amountRepaid : 0;
    }

    // Fixed repayment deadline, derived from the agreed durationDays. Only
    // meaningful once funded (status == Funded implies fundedAt != 0).
    function repaymentDueAt() public view returns (uint256) {
        return fundedAt + (durationDays * 1 days);
    }

    // Past the deadline but not yet liquidatable — informational for the UI.
    function isDelinquent() public view returns (bool) {
        return status == LoanStatus.Funded && block.timestamp > repaymentDueAt();
    }

    // The exact condition liquidate() enforces — safe for the frontend to poll.
    function isLiquidatable() public view returns (bool) {
        return status == LoanStatus.Funded && block.timestamp > repaymentDueAt() + GRACE_PERIOD;
    }
}
