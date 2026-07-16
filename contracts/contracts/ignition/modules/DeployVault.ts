import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("NexusFiVaultModule", (m) => {
    // This tells Hardhat to grab your compiled NexusFiVault and deploy it
    const vault = m.contract("NexusFiVault");

    return { vault };
});