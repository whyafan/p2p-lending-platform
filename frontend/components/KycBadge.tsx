'use client';

import { kycStatusLabel } from '../lib/kyc';

const COLOR_MAP: Record<string, string> = {
  APPROVED: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  PENDING: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  REJECTED: 'bg-red-500/20 text-red-400 border-red-500/30',
  MANUAL_REVIEW: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  NOT_STARTED: 'bg-slate-500/20 text-slate-400 border-slate-700',
  EXPIRED: 'bg-slate-500/20 text-slate-400 border-slate-700',
};

export function KycBadge({ status }: { status: string }) {
  const cls = COLOR_MAP[status] ?? COLOR_MAP.NOT_STARTED;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border ${cls}`}>
      {status === 'APPROVED' && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />}
      {kycStatusLabel(status)}
    </span>
  );
}
