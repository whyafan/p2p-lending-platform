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

    constructor() {
        admin = msg.sender;
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "KYCRegistry: zero admin");
        emit AdminUpdated(admin, newAdmin);
        admin = newAdmin;
    }

    function approveWallet(address wallet) external onlyAdmin {
        require(wallet != address(0), "KYCRegistry: zero wallet");
        isKycApproved[wallet] = true;
        emit WalletApproved(wallet);
    }

    function revokeWallet(address wallet) external onlyAdmin {
        isKycApproved[wallet] = false;
        emit WalletRevoked(wallet);
    }

    function approveWallets(address[] calldata wallets) external onlyAdmin {
        for (uint256 i = 0; i < wallets.length; i++) {
            address wallet = wallets[i];
            require(wallet != address(0), "KYCRegistry: zero wallet");
            isKycApproved[wallet] = true;
            emit WalletApproved(wallet);
        }
    }
}
