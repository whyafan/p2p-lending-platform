// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/// @title CollateralVault — sole custodian of borrower collateral
/// @notice Every position is keyed by loan id and can leave exactly once, either
///         released to the borrower or split between lender and borrower on
///         liquidation. Keeping custody here rather than in each Loan means the
///         funds live behind one audited access-control surface instead of one per
///         request, and a bug in a single Loan cannot drain another's collateral.
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

    // Authorises against the loan contract recorded when the position was locked, not
    // against a list the owner maintains. A Loan can therefore only ever move its own
    // collateral, and no privileged role can move anyone's.
    modifier onlyLoan(uint256 loanId) {
        require(msg.sender == positions[loanId].loanContract, "CollateralVault: caller is not loan");
        _;
    }

    constructor() Ownable(msg.sender) {}

    /// @notice Point the vault at the factory allowed to lock collateral into it.
    /// @dev Separate from the constructor because the two contracts reference each
    ///      other: the factory needs the vault address at deploy time, so the vault
    ///      has to exist first and learn the factory afterwards.
    /// @param newFactory Factory address to trust.
    /// Reverts if not called by the owner, or if newFactory is the zero address.
    function setFactory(address newFactory) external onlyOwner {
        require(newFactory != address(0), "CollateralVault: factory is zero address");

        factory = newFactory;
        emit FactoryUpdated(newFactory);
    }

    /// @notice Take custody of the attached ETH as the collateral for `loanId`.
    /// @param loanId Factory-assigned id, the key for this position.
    /// @param borrower Address the surplus or release goes back to.
    /// @param loanContract The only address subsequently allowed to move this position.
    /// Reverts unless called by the factory with non-zero value, non-zero borrower and
    /// loan addresses, and a loanId that has no position yet.
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

    /// @notice Seize `seizeAmount` for the lender and return the rest to the borrower.
    /// @dev Liquidation used to hand the lender the *entire* collateral no matter
    ///      how much was still owed, so a borrower who had repaid 90% still lost
    ///      everything and the lender collected far more than the debt. The Loan
    ///      contract now passes exactly what covers the outstanding balance and
    ///      whatever is left over goes back to the borrower in the same call.
    ///      Still one-shot: the position closes here, it is not drawn down twice.
    function liquidateCollateral(uint256 loanId, address payable recipient, uint256 seizeAmount)
        external
        onlyLoan(loanId)
        nonReentrant
    {
        CollateralPosition storage position = positions[loanId];

        require(!position.released, "CollateralVault: already released");
        require(!position.liquidated, "CollateralVault: already liquidated");
        require(recipient != address(0), "CollateralVault: recipient is zero address");

        uint256 total = position.amount;
        require(seizeAmount <= total, "CollateralVault: seize exceeds collateral");

        address payable borrower = payable(position.borrower);
        uint256 refund = total - seizeAmount;

        position.liquidated = true;
        position.amount = 0;

        if (seizeAmount > 0) {
            recipient.sendValue(seizeAmount);
        }
        if (refund > 0) {
            borrower.sendValue(refund);
        }

        emit CollateralLiquidated(loanId, recipient, seizeAmount);
        if (refund > 0) {
            emit CollateralReleased(loanId, borrower, refund);
        }
    }
}
