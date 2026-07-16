'use client';

import { useNetworkMode } from '../hooks/useNetworkMode';
import type { NetworkMode } from '../lib/network';

export function NetworkModeToggle() {
  const { mode, ready, setNetworkMode, config, walletError, clearWalletError } = useNetworkMode();

  if (!ready) {
    return <div className="h-10 w-[140px] animate-pulse rounded-xl bg-slate-200" />;
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        {(['local', 'testnet'] as NetworkMode[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => void setNetworkMode(key)}
            className={`rounded-lg px-3 py-2 text-xs font-black transition ${
              mode === key ? 'bg-slate-950 text-white' : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            {key === 'local' ? 'Local' : 'Testnet'}
          </button>
        ))}
      </div>
      <p className="text-[10px] font-medium text-slate-500">{config.description}</p>
      {walletError ? (
        <p className="max-w-[220px] text-[10px] font-medium text-amber-700" role="alert">
          {walletError}
          <button type="button" className="ml-1 underline" onClick={clearWalletError}>
            Dismiss
          </button>
        </p>
      ) : null}
    </div>
  );
}
