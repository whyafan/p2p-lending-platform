// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Loan} from "./Loan.sol";
import {CollateralVault} from "./CollateralVault.sol";

/// @title LoanFactory — deploys one Loan per request and keeps the registry
/// @notice The single entry point for borrowers. Holds the addresses every loan
///         needs to share (vault, price feed) and the demoMode flag, so those are
///         configured once at deployment rather than trusted per request.
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
    // Mappings are not enumerable, and the marketplace has to list every request
    // that ever existed. Kept private so the only reads go through the accessors
    // below, which is where pagination is enforced.
    uint256[] private loanIds;

    event LoanCreated(
        uint256 indexed loanId,
        address indexed borrower,
        address indexed loanContract,
        uint256 principalAmount,
        uint256 collateralAmount
    );

    /// @notice Wires the factory to its vault, oracle and demo setting for good.
    /// @param collateralVault_ Vault that will custody every loan's collateral.
    /// @param priceFeed_ Oracle handed to every Loan, or address(0) for none.
    /// @param demoMode_ Whether loans from this factory expose fastForward().
    /// Reverts if the vault is the zero address.
    constructor(address collateralVault_, address priceFeed_, bool demoMode_) {
        require(collateralVault_ != address(0), "LoanFactory: vault is zero address");
        collateralVault = CollateralVault(payable(collateralVault_));
        // address(0) is permitted: loans then fall back to deadline-only liquidation.
        priceFeed = priceFeed_;
        demoMode = demoMode_;
    }

    /// @notice Open a borrow request, posting the attached ETH as its collateral.
    /// @dev Terms arrive from the client, already derived from the borrower's tier by
    ///      lib/loan-terms.ts. The factory does not re-derive or validate them against
    ///      a tier — it enforces only the structural bounds below, and the fact that
    ///      they were written on chain at creation is what makes them auditable later.
    /// @param principalAmount Wei the borrower is asking for.
    /// @param durationDays Term length in days.
    /// @param interestBps Annualised rate in bps (base APR plus the tier spread).
    /// @param maxLtvBps Tier's maximum LTV in bps.
    /// @param liquidationBufferBps Headroom above maxLtv before liquidation opens.
    /// @return loanId Sequential id, also the vault's key for this collateral.
    /// @return loanContract Address of the freshly deployed Loan.
    /// Reverts on zero principal, zero msg.value, zero duration, or an LTV outside
    /// (0, 10000].
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

        // Id is claimed before the Loan is constructed because the Loan needs to know
        // it: the same number keys the vault position it will later release or seize.
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

        // Collateral moves last, after the registry is consistent. The vault only
        // accepts this call from the factory, so the loan contract it is told to
        // trust is the one deployed above and cannot be substituted by a caller.
        collateralVault.lockCollateral{value: msg.value}(loanId, msg.sender, loanContract);

        emit LoanCreated(loanId, msg.sender, loanContract, principalAmount, msg.value);
    }

    /// @notice Total number of loans ever created.
    /// @return Length of the id registry.
    function getLoanCount() external view returns (uint256) {
        return loanIds.length;
    }

    /// @notice Every loan id, unpaginated.
    /// @dev Convenient at demo volume; the caller pays for the whole array, so the
    ///      overload below is the one to use once the registry is large.
    /// @return All ids in creation order.
    function getLoanIds() external view returns (uint256[] memory) {
        return loanIds;
    }

    /// @notice A slice of the id registry.
    /// @dev Paginated overload — use when the total loan count may exceed RPC size limits.
    /// @param offset First index to return.
    /// @param limit Maximum ids to return.
    /// @return page Ids in [offset, offset + limit), truncated at the end of the registry.
    /// @return total Full registry length, so a caller can page without a second call.
    function getLoanIds(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory page, uint256 total)
    {
        total = loanIds.length;
        // Out-of-range paging returns an empty page with the real total rather than
        // reverting, so a client that overshoots the end just stops instead of erroring.
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
