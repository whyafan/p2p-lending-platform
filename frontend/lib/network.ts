import { hardhat, sepolia } from 'wagmi/chains';

export type NetworkMode = 'local' | 'testnet';

export const NETWORK_MODE_STORAGE_KEY = 'nexusfi-network-mode';

export const NETWORK_MODES: Record<
  NetworkMode,
  {
    label: string;
    description: string;
    chainId: number;
    chainName: string;
    factoryEnvKey: string;
    rpcEnvKey: string;
  }
> = {
  local: {
    label: 'Local test',
    description: 'Hardhat node (chain 31337)',
    chainId: hardhat.id,
    chainName: hardhat.name,
    factoryEnvKey: 'NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_LOCAL',
    rpcEnvKey: 'NEXT_PUBLIC_RPC_URL_LOCAL',
  },
  testnet: {
    label: 'Testnet',
    description: 'Sepolia — real wallet, test ETH',
    chainId: sepolia.id,
    chainName: sepolia.name,
    factoryEnvKey: 'NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA',
    rpcEnvKey: 'NEXT_PUBLIC_RPC_URL_SEPOLIA',
  },
};

export function getStoredNetworkMode(): NetworkMode {
  if (typeof window === 'undefined') return 'local';
  const stored = window.localStorage.getItem(NETWORK_MODE_STORAGE_KEY);
  return stored === 'testnet' ? 'testnet' : 'local';
}

export function setStoredNetworkMode(mode: NetworkMode) {
  window.localStorage.setItem(NETWORK_MODE_STORAGE_KEY, mode);
}

export function resolveFactoryAddress(mode: NetworkMode): `0x${string}` | undefined {
  const config = NETWORK_MODES[mode];
  const address =
    process.env[config.factoryEnvKey] ??
    (mode === 'local' ? process.env.NEXT_PUBLIC_LOAN_FACTORY_ADDRESS : undefined);
  if (!address) return undefined;
  return address as `0x${string}`;
}

export function resolveRpcUrl(mode: NetworkMode): string | undefined {
  const config = NETWORK_MODES[mode];
  return process.env[config.rpcEnvKey];
}

export function resolveMockPriceFeedAddress(mode: NetworkMode): `0x${string}` | undefined {
  const key =
    mode === 'local'
      ? 'NEXT_PUBLIC_MOCK_PRICE_FEED_ADDRESS_LOCAL'
      : 'NEXT_PUBLIC_MOCK_PRICE_FEED_ADDRESS_SEPOLIA';
  const val = process.env[key];
  return val && val !== '' ? (val as `0x${string}`) : undefined;
}
