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

    LoanStatus public status;

    event LoanFunded(uint256 indexed loanId, address indexed lender, uint256 amount);
    event LoanRepaid(uint256 indexed loanId, address indexed borrower, uint256 repaymentAmount);
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

    function repay() external payable onlyBorrower nonReentrant {
        require(status == LoanStatus.Funded, "Loan: not active");

        uint256 due = totalRepaymentDue();
        require(msg.value >= due, "Loan: repayment too small");

        status = LoanStatus.Repaid;
        payable(lender).sendValue(due);

        if (msg.value > due) {
            payable(msg.sender).sendValue(msg.value - due);
        }

        ICollateralVault(collateralVault).releaseCollateral(loanId, payable(borrower));
        emit LoanRepaid(loanId, msg.sender, due);
    }

    function cancel() external onlyBorrower nonReentrant {
        require(status == LoanStatus.Requested, "Loan: cannot cancel");

        status = LoanStatus.Cancelled;
        ICollateralVault(collateralVault).releaseCollateral(loanId, payable(borrower));
        emit LoanCancelled(loanId);
    }

    // Demo: maturity check removed so lender can trigger liquidation immediately
    // after a mock oracle price crash to demonstrate LTV breach in the UI.
    function markLiquidatedForDemo() external onlyLender nonReentrant {
        require(status == LoanStatus.Funded, "Loan: not active");

        status = LoanStatus.Liquidated;
        ICollateralVault(collateralVault).liquidateCollateral(loanId, payable(lender));
        emit LoanLiquidated(loanId, msg.sender);
    }

    function interestDue() public view returns (uint256) {
        return Math.mulDiv(principalAmount, interestBps * durationDays, 10_000 * 365);
    }

    function totalRepaymentDue() public view returns (uint256) {
        return principalAmount + interestDue();
    }
}
