import { hardhat, sepolia } from 'wagmi/chains';

export type NetworkMode = 'local' | 'testnet';

export const NETWORK_MODE_STORAGE_KEY = 'nexusfi-network-mode';

/**
 * Both supported networks described as data rather than as branches, so the label,
 * chain id and env keys for a mode are all in one place. label and description are
 * what the network switcher renders, which is why the copy lives here and not in the
 * component.
 */
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

/**
 * Reads the persisted mode, defaulting to local.
 *
 * Returns 'local' on the server rather than reading a cookie, so the server render is
 * deterministic. The real stored value only arrives after mount, which is why
 * useNetworkMode reads this in an effect instead of during render.
 *
 * Anything that is not exactly 'testnet' falls back to local, so a corrupted or
 * hand-edited storage value cannot point the app at a live network.
 */
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
  // Falls back to the unsuffixed NEXT_PUBLIC_LOAN_FACTORY_ADDRESS, and only for local:
  // that key predates the two-network split, and an existing .env.local from before
  // then would have been pointing at a Hardhat deployment.
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
