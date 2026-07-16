import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("NexusFiMilestone1", (m) => {
  const collateralVault = m.contract("CollateralVault");
  const loanFactory = m.contract("LoanFactory", [collateralVault]);
  // Initial price: $2,000/ETH. Owner (deployer) can call setPrice() to crash it for demo.
  const mockPriceFeed = m.contract("MockPriceFeed", [2000n]);

  m.call(collateralVault, "setFactory", [loanFactory]);

  return { collateralVault, loanFactory, mockPriceFeed };
});
