'use client';

import { BORROWER_PERSONAS } from '../lib/borrower-personas';

type Props = {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
};

const TIER_STYLE: Record<string, string> = {
  A: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  B: 'bg-amber-100 text-amber-700 border-amber-300',
  C: 'bg-red-100 text-red-700 border-red-300',
};

const CARD_SELECTED = 'ring-2 ring-indigo-500 border-indigo-400 bg-indigo-50';
const CARD_DEFAULT = 'border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40';

export function PersonaSelector({ selectedId, onSelect }: Props) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Demo borrower persona
        </p>
        {selectedId && (
          <button
            onClick={() => onSelect(null)}
            className="text-xs text-slate-400 hover:text-slate-600 underline"
          >
            Use my wallet
          </button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {BORROWER_PERSONAS.map((p) => {
          const isSelected = selectedId === p.id;
          return (
            <button
              key={p.id}
              onClick={() => onSelect(isSelected ? null : p.id)}
              className={`rounded-lg border p-3 text-left transition-all ${
                isSelected ? CARD_SELECTED : CARD_DEFAULT
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-semibold text-sm text-slate-800">{p.displayName}</span>
                <span
                  className={`text-xs font-bold px-1.5 py-0.5 rounded border ${
                    TIER_STYLE[p.expectedTier]
                  }`}
                >
                  Tier {p.expectedTier}
                </span>
              </div>
              <p className="text-xs text-slate-500 leading-snug line-clamp-3">{p.description}</p>
            </button>
          );
        })}
      </div>

      {selectedId && (
        <p className="text-[11px] text-amber-600 font-medium">
          DEMO DATA: simulated on-chain history. Real wallet data not used.
        </p>
      )}
    </div>
  );
}
