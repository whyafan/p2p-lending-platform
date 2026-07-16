import { network } from "hardhat";

async function main() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  console.log("Deploying NexusFi Milestone 1 contracts...");
  console.log("Deployer:", deployer.account.address);

  const collateralVault = await viem.deployContract("CollateralVault", [], {
    client: { wallet: deployer, public: publicClient },
  });

  const loanFactory = await viem.deployContract("LoanFactory", [collateralVault.address], {
    client: { wallet: deployer, public: publicClient },
  });

  await collateralVault.write.setFactory([loanFactory.address], {
    account: deployer.account,
  });

  console.log("CollateralVault:", collateralVault.address);
  console.log("LoanFactory:", loanFactory.address);
  console.log("Factory registered on vault.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
