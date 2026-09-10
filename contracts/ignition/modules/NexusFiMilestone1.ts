import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// The deployment of record for both localhost and Sepolia. Ignition tracks what it
// has already deployed per chain id, so re-running it resumes rather than duplicating,
// and the resulting addresses in ignition/deployments are what frontend/.env.local
// points at.
export default buildModule("NexusFiMilestone1", (m) => {
  const collateralVault = m.contract("CollateralVault");

  // Initial price: $2,000/ETH. Owner (deployer) can call setPrice() to crash it
  // and trigger price-based liquidation. Deployed before LoanFactory because the
  // factory now takes the feed address and hands it to every Loan it creates.
  const mockPriceFeed = m.contract("MockPriceFeed", [2000n]);

  // demoMode = true: enables Loan.fastForward() so the repayment-deadline and
  // grace-period paths can be demoed without waiting real days. A production
  // deployment would pass false.
  const loanFactory = m.contract("LoanFactory", [collateralVault, mockPriceFeed, true]);

  // Closes the circular dependency: the factory needed the vault's address to deploy,
  // so the vault can only learn the factory after the fact. Until this call lands,
  // lockCollateral reverts for everyone and no loan can be created.
  m.call(collateralVault, "setFactory", [loanFactory]);

  return { collateralVault, loanFactory, mockPriceFeed };
});
