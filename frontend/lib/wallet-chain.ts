import type { Chain, WalletClient } from 'viem';
import { hardhat, sepolia } from 'wagmi/chains';
import { resolveRpcUrl, type NetworkMode } from './network';

// Built fresh on each call rather than defined once, because the RPC URL it embeds
// comes from the environment and the returned object is handed to MetaMask as the
// definition of a network the user does not yet have.
function buildHardhatChain(): Chain {
  const rpc = resolveRpcUrl('local') ?? 'http://127.0.0.1:8545';
  return {
    ...hardhat,
    name: 'Hardhat Local',
    rpcUrls: {
      default: { http: [rpc] },
      public: { http: [rpc] },
    },
  };
}

export function getWalletChain(mode: NetworkMode): Chain {
  return mode === 'local' ? buildHardhatChain() : sepolia;
}

export function getWalletChainById(chainId: number): Chain | undefined {
  if (chainId === hardhat.id) return buildHardhatChain();
  if (chainId === sepolia.id) return sepolia;
  return undefined;
}

// 4902 is the standard "chain not added" code, but wallets are inconsistent about
// returning it, and wagmi wraps the original error besides. The string matching is the
// fallback for wallets that only say so in the message. A false positive here is
// cheap: the worst case is an addChain call the wallet rejects as a duplicate, which
// addChainIfNeeded already swallows.
function isMissingChainError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: number; message?: string };
  if (e.code === 4902) return true;
  const msg = (e.message ?? '').toLowerCase();
  return (
    msg.includes('unrecognized chain') ||
    msg.includes('wallet_switchethereumchain') ||
    msg.includes('unsupported')
  );
}

// Treats "already added" as success, since the goal is that the chain exists, not that
// this call is what created it. Any other failure still propagates: a user who
// declined the prompt must not be told the switch worked.
async function addChainIfNeeded(walletClient: WalletClient, chain: Chain): Promise<void> {
  try {
    await walletClient.addChain({ chain });
  } catch (error) {
    const msg = error instanceof Error ? error.message.toLowerCase() : '';
    if (!msg.includes('already') && !msg.includes('exists')) throw error;
  }
}

/**
 * Add chain to wallet if needed, then switch (required for Hardhat 31337 in MetaMask).
 *
 * Two paths on purpose. Sepolia is a chain every wallet already knows, so the ordinary
 * switch is tried first and adding is only the recovery path. Hardhat is skipped
 * straight to add-then-switch because trying the switch first there reliably fails and
 * costs the user a rejected prompt before the one that works.
 *
 * An unknown chain id returns silently rather than throwing: the app only ever passes
 * the two it supports, so an unrecognised id means a caller bug, not a user-facing one.
 */
export async function ensureWalletChain(params: {
  walletClient: WalletClient;
  switchChainAsync: (args: { chainId: number }) => Promise<unknown>;
  chainId: number;
}): Promise<void> {
  const { walletClient, switchChainAsync, chainId } = params;
  const chain = getWalletChainById(chainId);
  if (!chain) return;

  // MetaMask rejects wallet_switchEthereumChain for 31337 until the network exists.
  if (chainId === hardhat.id) {
    await addChainIfNeeded(walletClient, chain);
    await walletClient.switchChain({ id: chainId });
    return;
  }

  try {
    await switchChainAsync({ chainId });
    return;
  } catch (error) {
    if (!isMissingChainError(error)) throw error;
  }

  await addChainIfNeeded(walletClient, chain);
  await walletClient.switchChain({ id: chainId });
}
