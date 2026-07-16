import type { Chain, WalletClient } from 'viem';
import { hardhat, sepolia } from 'wagmi/chains';
import { resolveRpcUrl, type NetworkMode } from './network';

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

async function addChainIfNeeded(walletClient: WalletClient, chain: Chain): Promise<void> {
  try {
    await walletClient.addChain({ chain });
  } catch (error) {
    const msg = error instanceof Error ? error.message.toLowerCase() : '';
    if (!msg.includes('already') && !msg.includes('exists')) throw error;
  }
}

/** Add chain to wallet if needed, then switch (required for Hardhat 31337 in MetaMask). */
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
