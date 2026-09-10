import { network } from "hardhat";

/**
 * Post-deploy sanity check: confirms the freshly deployed set is live and
 * wired together, and that the pooled interface is what actually landed
 * on-chain rather than an older build.
 *
 *   npx hardhat run scripts/verify-deploy.ts --network sepolia
 */

const VAULT = "0x084a1b982ac01cae891417dea52b27b0e2b79a0f";
const PRICE_FEED = "0x43a39f432e38a7665db04a536c4d19460331bb6f";
const FACTORY = "0x0e3ea8f226434feadb267d05c9c4ef8f951c7d00";

async function main() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();

  const vault = await viem.getContractAt("CollateralVault", VAULT as `0x${string}`);
  const feed = await viem.getContractAt("MockPriceFeed", PRICE_FEED as `0x${string}`);
  const factory = await viem.getContractAt("LoanFactory", FACTORY as `0x${string}`);

  const [vaultCode, feedCode, factoryCode] = await Promise.all([
    publicClient.getCode({ address: VAULT as `0x${string}` }),
    publicClient.getCode({ address: PRICE_FEED as `0x${string}` }),
    publicClient.getCode({ address: FACTORY as `0x${string}` }),
  ]);

  console.log("Bytecode present:");
  console.log("  CollateralVault:", (vaultCode?.length ?? 0) > 2);
  console.log("  MockPriceFeed:  ", (feedCode?.length ?? 0) > 2);
  console.log("  LoanFactory:    ", (factoryCode?.length ?? 0) > 2);

  console.log("");
  console.log("Wiring:");
  const registeredFactory = await vault.read.factory();
  console.log("  vault.factory() ==", registeredFactory);
  console.log("  matches deployed factory:", registeredFactory.toLowerCase() === FACTORY);

  console.log("");
  console.log("Factory config:");
  console.log("  collateralVault():", await factory.read.collateralVault());
  console.log("  priceFeed():      ", await factory.read.priceFeed());
  console.log("  demoMode():       ", await factory.read.demoMode());
  console.log("  nextLoanId():     ", await factory.read.nextLoanId());

  console.log("");
  console.log("Oracle:");
  console.log("  latestPrice():", await feed.read.latestPrice());

  console.log("");
  console.log("Loans on this factory:", (await factory.read.getLoanIds()).length);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
