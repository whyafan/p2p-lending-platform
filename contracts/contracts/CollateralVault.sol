// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

contract CollateralVault is Ownable, ReentrancyGuard {
    using Address for address payable;

    struct CollateralPosition {
        address borrower;
        address loanContract;
        uint256 amount;
        bool released;
        bool liquidated;
    }

    mapping(uint256 => CollateralPosition) public positions;
    address public factory;

    event FactoryUpdated(address indexed factory);
    event CollateralLocked(
        uint256 indexed loanId,
        address indexed borrower,
        address indexed loanContract,
        uint256 amount
    );
    event CollateralReleased(uint256 indexed loanId, address indexed recipient, uint256 amount);
    event CollateralLiquidated(uint256 indexed loanId, address indexed recipient, uint256 amount);

    modifier onlyFactory() {
        require(msg.sender == factory, "CollateralVault: caller is not factory");
        _;
    }

    modifier onlyLoan(uint256 loanId) {
        require(msg.sender == positions[loanId].loanContract, "CollateralVault: caller is not loan");
        _;
    }

    constructor() Ownable(msg.sender) {}

    function setFactory(address newFactory) external onlyOwner {
        require(newFactory != address(0), "CollateralVault: factory is zero address");

        factory = newFactory;
        emit FactoryUpdated(newFactory);
    }

    function lockCollateral(
        uint256 loanId,
        address borrower,
        address loanContract
    ) external payable onlyFactory nonReentrant {
        require(msg.value > 0, "CollateralVault: collateral required");
        require(borrower != address(0), "CollateralVault: borrower is zero address");
        require(loanContract != address(0), "CollateralVault: loan is zero address");
        require(positions[loanId].amount == 0, "CollateralVault: position exists");

        positions[loanId] = CollateralPosition({
            borrower: borrower,
            loanContract: loanContract,
            amount: msg.value,
            released: false,
            liquidated: false
        });

        emit CollateralLocked(loanId, borrower, loanContract, msg.value);
    }

    function releaseCollateral(uint256 loanId, address payable recipient)
        external
        onlyLoan(loanId)
        nonReentrant
    {
        CollateralPosition storage position = positions[loanId];

        require(!position.released, "CollateralVault: already released");
        require(!position.liquidated, "CollateralVault: already liquidated");
        require(recipient != address(0), "CollateralVault: recipient is zero address");

        uint256 amount = position.amount;
        position.released = true;
        position.amount = 0;

        recipient.sendValue(amount);
        emit CollateralReleased(loanId, recipient, amount);
    }

    function liquidateCollateral(uint256 loanId, address payable recipient)
        external
        onlyLoan(loanId)
        nonReentrant
    {
        CollateralPosition storage position = positions[loanId];

        require(!position.released, "CollateralVault: already released");
        require(!position.liquidated, "CollateralVault: already liquidated");
        require(recipient != address(0), "CollateralVault: recipient is zero address");

        uint256 amount = position.amount;
        position.liquidated = true;
        position.amount = 0;

        recipient.sendValue(amount);
        emit CollateralLiquidated(loanId, recipient, amount);
    }
}
