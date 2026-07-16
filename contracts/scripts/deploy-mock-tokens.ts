import { network } from "hardhat";

const TOKENS = [
  { env: "USDC", name: "Mock USDC", symbol: "mUSDC", decimals: 6 },
  { env: "WETH", name: "Mock WETH", symbol: "mWETH", decimals: 18 },
  { env: "WBTC", name: "Mock WBTC", symbol: "mWBTC", decimals: 8 },
] as const;

async function main() {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  const chainId = await publicClient.getChainId();
  const suffix = chainId === 31337n || chainId === 31337 ? "LOCAL" : "SEPOLIA";

  console.log(`\nDeploying mock ERC-20 tokens (chainId ${chainId}, deployer ${deployer.account.address})...\n`);

  for (const token of TOKENS) {
    const contract = await viem.deployContract(
      "MockERC20",
      [token.name, token.symbol, token.decimals],
      { client: { wallet: deployer, public: publicClient } }
    );
    console.log(`NEXT_PUBLIC_TOKEN_${token.env}_${suffix}=${contract.address}`);
  }

  console.log("\nPaste the lines above into frontend/.env.local\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
