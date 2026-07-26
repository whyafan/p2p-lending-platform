import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("NexusFiMilestone1", (m) => {
  const collateralVault = m.contract("CollateralVault");

  // Initial price: $2,000/ETH. Owner (deployer) can call setPrice() to crash it
  // and trigger price-based liquidation. Deployed before LoanFactory because the
  // factory now takes the feed address and hands it to every Loan it creates.
  const mockPriceFeed = m.contract("MockPriceFeed", [2000n]);

  const loanFactory = m.contract("LoanFactory", [collateralVault, mockPriceFeed]);

  m.call(collateralVault, "setFactory", [loanFactory]);

  return { collateralVault, loanFactory, mockPriceFeed };
});
