// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice On-chain allowlist for KYC-approved wallets (backend/admin only in M1).
contract KYCRegistry {
    address public admin;
    mapping(address => bool) public isKycApproved;

    event AdminUpdated(address indexed previousAdmin, address indexed newAdmin);
    event WalletApproved(address indexed wallet);
    event WalletRevoked(address indexed wallet);

    modifier onlyAdmin() {
        require(msg.sender == admin, "KYCRegistry: not admin");
        _;
    }

    /// @notice Sets the deployer as the initial admin.
    constructor() {
        admin = msg.sender;
    }

    /// @notice Hand the admin role to another address.
    /// @param newAdmin The incoming admin.
    /// Reverts unless the caller is the current admin and newAdmin is non-zero.
    function setAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "KYCRegistry: zero admin");
        // Emitted before the assignment so the event carries the outgoing admin.
        emit AdminUpdated(admin, newAdmin);
        admin = newAdmin;
    }

    /// @notice Mark a wallet as KYC approved.
    /// @param wallet Wallet to approve.
    /// Reverts unless the caller is the admin and wallet is non-zero.
    function approveWallet(address wallet) external onlyAdmin {
        require(wallet != address(0), "KYCRegistry: zero wallet");
        isKycApproved[wallet] = true;
        emit WalletApproved(wallet);
    }

    /// @notice Withdraw a wallet's approval.
    /// @dev No zero-address check, unlike approveWallet: revoking is idempotent and
    ///      clearing a slot that was never set is harmless.
    /// @param wallet Wallet to revoke.
    /// Reverts unless the caller is the admin.
    function revokeWallet(address wallet) external onlyAdmin {
        isKycApproved[wallet] = false;
        emit WalletRevoked(wallet);
    }

    /// @notice Approve a batch of wallets in one transaction.
    /// @dev Emits one WalletApproved per wallet so indexers see the same event shape
    ///      as the single-wallet path. Unbounded loop: the caller sizes the batch to
    ///      fit the block gas limit.
    /// @param wallets Wallets to approve.
    /// Reverts unless the caller is the admin and every entry is non-zero; a single
    /// zero address reverts the whole batch.
    function approveWallets(address[] calldata wallets) external onlyAdmin {
        for (uint256 i = 0; i < wallets.length; i++) {
            address wallet = wallets[i];
            require(wallet != address(0), "KYCRegistry: zero wallet");
            isKycApproved[wallet] = true;
            emit WalletApproved(wallet);
        }
    }
}
