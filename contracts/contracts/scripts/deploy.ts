import "@nomicfoundation/hardhat-viem";
import { network } from "hardhat";

async function main() {
    console.log("Initiating deployment sequence...");

    // Get viem from the network connection in Hardhat v3
    const { viem } = await network.connect();

    // This grabs your compiled contract and fires it onto the blockchain
    const vault = await viem.deployContract("NexusFiVault");

    console.log("🚀 MISSION ACCOMPLISHED!");
    console.log("Deployed Address:", vault.address);
}

main().catch((error) => {
    console.error("Deployment failed:", error);
    process.exitCode = 1;
});