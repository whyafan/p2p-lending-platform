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

/**
 * The app's network selection, and the wallet's, kept in step.
 *
 * Two things can disagree here: what the app thinks it is pointed at, and what chain
 * the wallet is actually on. This hook owns the first and asks the wallet to follow.
 * It does not force the reverse, so a user who switches network in MetaMask is not
 * fought by the app.
 *
 * `ready` exists because the stored mode is only readable after mount. Rendering
 * network-dependent output before then would produce server and client markup that
 * disagree, so callers wait on it rather than on `mode` alone.
 */
export function useNetworkMode() {
  // Starts at 'local' to match what the server rendered; the effect below replaces it
  // on mount with whatever was actually stored.
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
      // App state moves first and is not rolled back if the wallet switch fails. The
      // selection is the user's stated intent; a wallet that refused to follow is
      // reported through walletError rather than by silently reverting their choice.
      setStoredNetworkMode(next);
      setMode(next);
      const targetChainId = NETWORK_MODES[next].chainId;
      // Nothing to ask a wallet that is not connected, and nothing to switch if it is
      // already there. Prompting anyway would produce a pointless MetaMask popup.
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
