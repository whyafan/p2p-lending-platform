// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Loan} from "./Loan.sol";
import {CollateralVault} from "./CollateralVault.sol";

contract LoanFactory {
    struct LoanTerms {
        address loanContract;
        address borrower;
        uint256 principalAmount;
        uint256 collateralAmount;
        uint256 durationDays;
        uint256 interestBps;
        uint256 maxLtvBps;
        uint256 liquidationBufferBps;
        uint256 createdAt;
    }

    CollateralVault public immutable collateralVault;
    /// Oracle passed to every Loan for price-based liquidation. May be address(0).
    address public immutable priceFeed;
    /// Passed to every Loan; enables fastForward() for time-based demos.
    bool public immutable demoMode;
    uint256 public nextLoanId;

    mapping(uint256 => LoanTerms) public loans;
    uint256[] private loanIds;

    event LoanCreated(
        uint256 indexed loanId,
        address indexed borrower,
        address indexed loanContract,
        uint256 principalAmount,
        uint256 collateralAmount
    );

    constructor(address collateralVault_, address priceFeed_, bool demoMode_) {
        require(collateralVault_ != address(0), "LoanFactory: vault is zero address");
        collateralVault = CollateralVault(payable(collateralVault_));
        // address(0) is permitted: loans then fall back to deadline-only liquidation.
        priceFeed = priceFeed_;
        demoMode = demoMode_;
    }

    function createLoan(
        uint256 principalAmount,
        uint256 durationDays,
        uint256 interestBps,
        uint256 maxLtvBps,
        uint256 liquidationBufferBps
    ) external payable returns (uint256 loanId, address loanContract) {
        require(principalAmount > 0, "LoanFactory: principal required");
        require(msg.value > 0, "LoanFactory: collateral required");
        require(durationDays > 0, "LoanFactory: duration required");
        require(maxLtvBps > 0 && maxLtvBps <= 10_000, "LoanFactory: invalid LTV");

        loanId = nextLoanId;
        nextLoanId++;

        Loan loan = new Loan(
            loanId,
            address(this),
            msg.sender,
            principalAmount,
            msg.value,
            durationDays,
            interestBps,
            maxLtvBps,
            liquidationBufferBps,
            address(collateralVault),
            priceFeed
        );

        loanContract = address(loan);

        loans[loanId] = LoanTerms({
            loanContract: loanContract,
            borrower: msg.sender,
            principalAmount: principalAmount,
            collateralAmount: msg.value,
            durationDays: durationDays,
            interestBps: interestBps,
            maxLtvBps: maxLtvBps,
            liquidationBufferBps: liquidationBufferBps,
            createdAt: block.timestamp
        });
        loanIds.push(loanId);

        collateralVault.lockCollateral{value: msg.value}(loanId, msg.sender, loanContract);

        emit LoanCreated(loanId, msg.sender, loanContract, principalAmount, msg.value);
    }

    function getLoanCount() external view returns (uint256) {
        return loanIds.length;
    }

    function getLoanIds() external view returns (uint256[] memory) {
        return loanIds;
    }

    // Paginated overload — use when the total loan count may exceed RPC size limits.
    function getLoanIds(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory page, uint256 total)
    {
        total = loanIds.length;
        if (offset >= total || limit == 0) {
            return (new uint256[](0), total);
        }
        uint256 end = offset + limit > total ? total : offset + limit;
        uint256 size = end - offset;
        page = new uint256[](size);
        for (uint256 i = 0; i < size; i++) {
            page[i] = loanIds[offset + i];
        }
    }
}
