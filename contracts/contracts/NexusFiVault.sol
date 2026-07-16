// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract NexusFiVault {
    struct Loan {
        address borrower;
        uint256 requestedAmount;
        uint256 collateralAmount;
        uint256 maxLTV;
        uint256 interestSpread;
        uint256 liquidationBuffer;
        bool isFunded;
        bool isActive;
    }

    mapping(uint256 => Loan) public loans;
    uint256 public nextLoanId;

    event CollateralLocked(uint256 indexed loanId, address indexed borrower, uint256 amount);
    event LoanFunded(uint256 indexed loanId, address indexed lender, uint256 amount);

    function lockCollateralAndList(
        uint256 _requestedAmount,
        uint256 _maxLTV,
        uint256 _interestSpread,
        uint256 _liquidationBuffer
    ) external payable {
        require(msg.value > 0, "Must deposit collateral");

        uint256 loanId = nextLoanId;
        
        loans[loanId] = Loan({
            borrower: msg.sender,
            requestedAmount: _requestedAmount,
            collateralAmount: msg.value,
            maxLTV: _maxLTV,
            interestSpread: _interestSpread,
            liquidationBuffer: _liquidationBuffer,
            isFunded: false,
            isActive: false
        });

        nextLoanId++;
        emit CollateralLocked(loanId, msg.sender, msg.value);
    }

    // THE MISSING PIECE: The Lender Function!
    function fundLoan(uint256 _loanId) external payable {
        Loan storage loan = loans[_loanId];
        
        require(!loan.isFunded, "Loan is already funded");
        require(msg.value == loan.requestedAmount, "Must send exact requested amount");

        loan.isFunded = true;
        loan.isActive = true;

        emit LoanFunded(_loanId, msg.sender, msg.value);
    }

    function getLoan(uint256 _loanId) external view returns (Loan memory) {
        return loans[_loanId];
    }
}