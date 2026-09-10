import { network } from "hardhat";

/**
 * Deploys the full NexusFi contract set and wires it together.
 *
 * Mirrors ignition/modules/NexusFiMilestone1.ts, but runs through
 * `hardhat run`, which needs no interactive confirmation. Use this when
 * deploying from a non-TTY shell; use the Ignition module when you want
 * deployment state tracking and resumability.
 *
 *   npx hardhat run scripts/deploy-milestone1.ts --network sepolia
 */

// Initial mock oracle price, in whole dollars per ETH.
const INITIAL_ETH_USD = 2000n;

// demoMode = true enables Loan.fastForward(), so the repayment-deadline and
// grace-period paths can be demoed without waiting real days. A production
// deployment would pass false.
const DEMO_MODE = true;

async function main() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  console.log("Deploying NexusFi contracts...");
  console.log("Deployer:", deployer.account.address);

  const collateralVault = await viem.deployContract("CollateralVault", [], {
    client: { wallet: deployer, public: publicClient },
  });
  console.log("CollateralVault:", collateralVault.address);

  // Deployed before LoanFactory: the factory takes the feed address and hands
  // it to every Loan it creates.
  const mockPriceFeed = await viem.deployContract("MockPriceFeed", [INITIAL_ETH_USD], {
    client: { wallet: deployer, public: publicClient },
  });
  console.log("MockPriceFeed:", mockPriceFeed.address);

  const loanFactory = await viem.deployContract(
    "LoanFactory",
    [collateralVault.address, mockPriceFeed.address, DEMO_MODE],
    { client: { wallet: deployer, public: publicClient } },
  );
  console.log("LoanFactory:", loanFactory.address);

  await collateralVault.write.setFactory([loanFactory.address], {
    account: deployer.account,
  });
  console.log("Factory registered on vault.");

  console.log("");
  console.log("Add these to frontend/.env:");
  console.log(`NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA=${loanFactory.address}`);
  console.log(`NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS_SEPOLIA=${collateralVault.address}`);
  console.log(`NEXT_PUBLIC_MOCK_PRICE_FEED_ADDRESS_SEPOLIA=${mockPriceFeed.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
