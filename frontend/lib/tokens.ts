import type { NetworkMode } from './network';

export type TokenSymbol = 'ETH' | 'WETH' | 'USDC' | 'WBTC';

export type SupportedToken = {
  symbol: TokenSymbol;
  name: string;
  decimals: number;
  /** CoinGecko id for live USD price */
  coingeckoId: string;
  /** Native chain asset (no ERC-20 address) */
  isNative?: boolean;
  /** ERC-20 address per network mode (local mocks / sepolia) */
  addresses: Partial<Record<NetworkMode, `0x${string}`>>;
  roles: ('collateral' | 'borrow')[];
};

export const SUPPORTED_TOKENS: SupportedToken[] = [
  {
    symbol: 'ETH',
    name: 'Ether',
    decimals: 18,
    coingeckoId: 'ethereum',
    isNative: true,
    addresses: {},
    roles: ['collateral', 'borrow'],
  },
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    coingeckoId: 'ethereum',
    addresses: {
      local: (process.env.NEXT_PUBLIC_TOKEN_WETH_LOCAL ?? '') as `0x${string}`,
      testnet: (process.env.NEXT_PUBLIC_TOKEN_WETH_SEPOLIA ?? '') as `0x${string}`,
    },
    roles: ['collateral'],
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    coingeckoId: 'usd-coin',
    addresses: {
      local: (process.env.NEXT_PUBLIC_TOKEN_USDC_LOCAL ?? '') as `0x${string}`,
      testnet: (process.env.NEXT_PUBLIC_TOKEN_USDC_SEPOLIA ?? '') as `0x${string}`,
    },
    roles: ['borrow', 'collateral'],
  },
  {
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
    decimals: 8,
    coingeckoId: 'wrapped-bitcoin',
    addresses: {
      local: (process.env.NEXT_PUBLIC_TOKEN_WBTC_LOCAL ?? '') as `0x${string}`,
      testnet: (process.env.NEXT_PUBLIC_TOKEN_WBTC_SEPOLIA ?? '') as `0x${string}`,
    },
    roles: ['collateral'],
  },
];

/**
 * Tokens usable for a role on a given network.
 *
 * The address check is what keeps this honest: the ERC-20 entries above resolve from
 * env vars that are empty until the mock tokens are deployed, and offering a token the
 * app has no address for would produce a transaction to the zero address. ETH is exempt
 * because it is native and has no contract to point at. Today the loan contracts are
 * ETH-only, so only the ETH entry is ever reachable in the live flow.
 */
export function tokensForRole(mode: NetworkMode, role: 'collateral' | 'borrow') {
  return SUPPORTED_TOKENS.filter((token) => {
    if (!token.roles.includes(role)) return false;
    if (token.isNative) return true;
    const address = token.addresses[mode];
    return address && address.length > 2;
  });
}

export function getToken(symbol: TokenSymbol) {
  return SUPPORTED_TOKENS.find((t) => t.symbol === symbol);
}
