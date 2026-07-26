// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MockPriceFeed — admin-controlled ETH/USD oracle for demo liquidations
/// @notice Owner calls setPrice() to simulate a market crash; the UI reads
///         ethUsdPrice to recalculate live LTV and gate the liquidation button.
contract MockPriceFeed {
    uint256 public ethUsdPrice;
    address public owner;

    event PriceUpdated(uint256 oldPrice, uint256 newPrice, address indexed setBy);

    constructor(uint256 initialPrice_) {
        ethUsdPrice = initialPrice_;
        owner = msg.sender;
    }

    /// @notice Set mock ETH/USD price (whole dollars, e.g. 2000 for $2,000).
    /// @dev Deliberately permissionless. This is a *mock* oracle whose entire
    ///      purpose is letting anyone demo a price crash on testnet — gating it
    ///      to the deployer would mean only one teammate could ever run the
    ///      liquidation demo. Never ship this contract to a real network.
    function setPrice(uint256 newPrice) external {
        uint256 old = ethUsdPrice;
        ethUsdPrice = newPrice;
        emit PriceUpdated(old, newPrice, msg.sender);
    }

    /// @notice Returns the current mock ETH/USD price.
    function latestPrice() external view returns (uint256) {
        return ethUsdPrice;
    }
}
