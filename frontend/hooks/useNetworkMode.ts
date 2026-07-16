'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi';
import {
  getStoredNetworkMode,
  NETWORK_MODES,
  setStoredNetworkMode,
  type NetworkMode,
} from '../lib/network';
import { ensureWalletChain } from '../lib/wallet-chain';

export function useNetworkMode() {
  const [mode, setMode] = useState<NetworkMode>('local');
  const [ready, setReady] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const { chainId, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { data: walletClient } = useWalletClient();

  useEffect(() => {
    setMode(getStoredNetworkMode());
    setReady(true);
  }, []);

  const setNetworkMode = useCallback(
    async (next: NetworkMode) => {
      setWalletError(null);
      setStoredNetworkMode(next);
      setMode(next);
      const targetChainId = NETWORK_MODES[next].chainId;
      if (!isConnected || !walletClient || chainId === targetChainId) return;

      try {
        await ensureWalletChain({
          walletClient,
          switchChainAsync,
          chainId: targetChainId,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Wallet could not switch networks. For Local, add Hardhat (31337) in your wallet or start `npx hardhat node`.';
        setWalletError(message);
      }
    },
    [chainId, isConnected, switchChainAsync, walletClient]
  );

  return {
    mode,
    ready,
    setNetworkMode,
    walletError,
    clearWalletError: () => setWalletError(null),
    chainId: NETWORK_MODES[mode].chainId,
    config: NETWORK_MODES[mode],
  };
}
