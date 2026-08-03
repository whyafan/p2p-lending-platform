// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mintable test token for local / Sepolia demos.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    /// @notice Deploys a token with an arbitrary decimals value and mints the supply
    ///         to the deployer.
    /// @dev decimals is a constructor argument rather than the ERC20 default of 18 so
    ///      one contract can stand in for tokens that differ there, like a 6-decimal
    ///      USDC, which is where decimal-handling bugs actually show up.
    /// @param name_ Token name.
    /// @param symbol_ Token symbol.
    /// @param decimals_ Decimals this token reports.
    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
        _mint(msg.sender, 1_000_000_000 * (10 ** uint256(decimals_)));
    }

    /// @notice Decimals this token reports, as fixed at deployment.
    /// @return The configured decimals.
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mint tokens to any address.
    /// @dev Unguarded on purpose: anyone testing against a local node or Sepolia needs
    ///      a balance without going through the deployer. Test-only contract.
    /// @param to Recipient.
    /// @param amount Amount in the token's own decimals.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
