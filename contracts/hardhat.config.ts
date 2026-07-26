import "@nomicfoundation/hardhat-toolbox-viem";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";
import * as dotenv from "dotenv";
dotenv.config();

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  // Source verification. Sourcify and Blockscout need no API key, so they work
  // out of the box; Etherscan needs a free key in ETHERSCAN_API_KEY and stays
  // disabled without one (enabling it keyless makes every verify run fail).
  verify: {
    etherscan: process.env.ETHERSCAN_API_KEY
      ? { apiKey: process.env.ETHERSCAN_API_KEY, enabled: true as const }
      : { enabled: false as const },
    sourcify: { enabled: true },
    blockscout: { enabled: true },
  },
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: process.env.SEPOLIA_RPC_URL ?? "https://sepolia.drpc.org",
      accounts: process.env.SEPOLIA_PRIVATE_KEY ? [process.env.SEPOLIA_PRIVATE_KEY] : [],
    },
  },
});
