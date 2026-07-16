import { createConfig, http } from 'wagmi';
import { hardhat, sepolia } from 'wagmi/chains';
import { metaMask } from 'wagmi/connectors';

type WagmiConfig = ReturnType<typeof createConfig>;

const globalForWagmi = globalThis as typeof globalThis & {
  __nexusfiWagmiConfig?: WagmiConfig;
};

function buildConnectors() {
  return [
    metaMask({
      dappMetadata: {
        name: 'NexusFi Protocol',
        url: 'http://localhost:3000',
      },
    }),
  ];
}

function createWagmiConfig() {
  const localRpc = process.env.NEXT_PUBLIC_RPC_URL_LOCAL ?? 'http://127.0.0.1:8545';

  // Browser → same-origin proxy (/api/rpc/sepolia) so there are no CORS issues and
  // the Alchemy key never reaches the client.
  // Server (SSR) → direct URL, server-to-server calls have no CORS restrictions.
  const sepoliaRpc =
    typeof window === 'undefined'
      ? (process.env.NEXT_PUBLIC_RPC_URL_SEPOLIA ??
         process.env.NEXT_PUBLIC_ALCHEMY_SEPOLIA_URL ??
         'https://ethereum-sepolia-rpc.publicnode.com')
      : '/api/rpc/sepolia';

  return createConfig({
    chains: [hardhat, sepolia],
    connectors: buildConnectors(),
    multiInjectedProviderDiscovery: false,
    ssr: true,
    transports: {
      [hardhat.id]: http(localRpc),
      [sepolia.id]: http(sepoliaRpc),
    },
  });
}

export function getConfig() {
  if (!globalForWagmi.__nexusfiWagmiConfig) {
    globalForWagmi.__nexusfiWagmiConfig = createWagmiConfig();
  }
  return globalForWagmi.__nexusfiWagmiConfig;
}
