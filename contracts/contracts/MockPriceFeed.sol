// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MockPriceFeed — admin-controlled ETH/USD oracle for demo liquidations
/// @notice Owner calls setPrice() to simulate a market crash; the UI reads
///         ethUsdPrice to recalculate live LTV and gate the liquidation button.
contract MockPriceFeed {
    uint256 public ethUsdPrice;
    address public owner;

    event PriceUpdated(uint256 oldPrice, uint256 newPrice);

    constructor(uint256 initialPrice_) {
        ethUsdPrice = initialPrice_;
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "MockPriceFeed: not owner");
        _;
    }

    /// @notice Set mock ETH/USD price (whole dollars, e.g. 2000 for $2,000).
    function setPrice(uint256 newPrice) external onlyOwner {
        uint256 old = ethUsdPrice;
        ethUsdPrice = newPrice;
        emit PriceUpdated(old, newPrice);
    }

    /// @notice Returns the current mock ETH/USD price.
    function latestPrice() external view returns (uint256) {
        return ethUsdPrice;
    }
}
