/**
 * Statement generation (T3): P&L, Tax P&L and Tradebook as PDFs.
 *
 * Built entirely from indexed on-chain events plus the per-event price snapshots,
 * so every figure traces back to a transaction hash a reader can verify. Nothing
 * here is derived from wallet balances, which is the whole point — MetaMask
 * cannot show internal contract transfers, so it can't be the source of truth.
 */

import { formatEther } from 'viem';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { LoanEvent } from './loan-events';
import { EVENT_LABEL } from './loan-events';
import {
  hasShareData,
  myShareEvents,
  OUTBOUND_KINDS,
  splitSharesByLiquidation,
  sumAmounts,
  viewerLedgerEvents,
} from './share-math.ts';

export type StatementRole = 'lender' | 'borrower';

export type StatementLoan = {
  loanId: string;
  loanContract: string;
  principal: bigint;
  collateral: bigint;
  interestBps: number;
  durationDays: number;
  statusVal: number;
  counterparty?: string;
  events: LoanEvent[];
  /**
   * This viewer's own `contributions(address)` read from the contract, when
   * known. `loan.events` is period-filtered by the caller (StatementsPanel),
   * so summing `contribution` events for a cost basis silently collapses to
   * zero the moment the viewer's contribution fell outside the reporting
   * window while their share payout stayed inside it (C1). This is the
   * authoritative value read straight off the contract - always the full
   * amount, regardless of the period filter.
   */
  myContribution?: bigint;
};

export type StatementMeta = {
  role: StatementRole;
  walletAddress?: string;
  email?: string;
  /** Values an event; `estimated` when no snapshot existed for it. */
  priceFor: (e: LoanEvent) => { usd: number; estimated: boolean };
  currentEthUsd: number;
  /** Reporting period the caller filtered to, printed on every statement. */
  periodLabel?: string;
};

const ETH = (w: bigint) => parseFloat(formatEther(w));
// 8 decimals, not 18: enough that interest on a small loan is still visible, few
// enough that a table column stays readable. Precision is lost only for display, the
// arithmetic above stays in wei.
const fmtEth = (w: bigint) => ETH(w).toFixed(8);
const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
const dt = (ts?: number) => (ts ? new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) : '—');
// A pending ShareDistributed hasn't actually reached the lender - the push
// failed and it's sitting in pendingWithdrawals until withdraw() is called.
// Printing it as plain "Share paid out" reads as money already received.
const eventLabel = (e: LoanEvent) =>
  e.kind === 'share-distributed' && e.pending ? `${EVENT_LABEL[e.kind]} (pending)` : EVENT_LABEL[e.kind];

/**
 * Net position on one loan, from the perspective of `role`.
 *
<<<<<<< HEAD
 * The two sides are not mirror images, because collateral only ever moves on the
 * borrower's side. A lender's ledger is the principal out against repayments and any
 * seizure in. The borrower's counts the collateral as an outflow when it is posted and
 * as an inflow when it comes back, so a loan repaid in full nets to exactly the
 * interest paid rather than to zero, and a liquidated one nets to the collateral that
 * did not return.
 *
 * Read from events rather than from contract state, so the figures agree with the
 * tradebook row for row and each one has a transaction hash behind it.
 */
export function computeLoanPnl(loan: StatementLoan, role: StatementRole) {
=======
 * For a lender on a pooled loan, `viewerAddress` picks out their own
 * ShareDistributed events rather than the loan's totals - the fallback gate
 * is `hasShareData(loan.events)`: with no ShareDistributed events at all (an
 * old loan, or one the indexer hasn't caught up to), this reverts to the
 * original loan-level computation unchanged.
 */
export function computeLoanPnl(loan: StatementLoan, role: StatementRole, viewerAddress?: string) {
>>>>>>> atharva
  const zero = BigInt(0);
  const repayments = loan.events.filter(
    (e) => e.kind === 'partial-repayment' || e.kind === 'repaid',
  );
  const totalRepaidLoanWide = repayments.reduce((s, e) => s + e.amount, zero);
  const liq = loan.events.find((e) => e.kind === 'liquidated');
  const seizedLoanWide = liq?.amount ?? zero;
  const refunded = liq?.refunded ?? zero;
  // Status comes from the contract, not from the presence of a liquidation event: a
  // chunk of logs that failed to fetch would otherwise silently reclassify a
  // liquidated loan as open and drop the collateral loss from the statement.
  const liquidated = loan.statusVal === 4;

  if (role === 'lender') {
    const usePerShare = Boolean(viewerAddress) && hasShareData(loan.events);
    if (usePerShare) {
      const addr = (viewerAddress as string).toLowerCase();
      const mine = myShareEvents(loan.events, viewerAddress as string);
      const { seizureShares, repaymentShares } = splitSharesByLiquidation(mine, liq?.txHash);
      // Prefer the contract-read value (C1): it is unaffected by the caller's
      // period filter. Only fall back to summing contribution events - which
      // can be wrongly filtered out of range - when it wasn't supplied.
      const myContribution =
        loan.myContribution ??
        sumAmounts(loan.events.filter((e) => e.kind === 'contribution' && e.actor?.toLowerCase() === addr));
      const totalRepaid = sumAmounts(repaymentShares);
      const seized = sumAmounts(seizureShares);
      const outflow = myContribution;
      const inflow = totalRepaid + seized;
      return { outflow, inflow, net: inflow - outflow, liquidated, totalRepaid, seized, refunded };
    }
    const outflow = loan.principal;
    const inflow = totalRepaidLoanWide + seizedLoanWide;
    return {
      outflow,
      inflow,
      net: inflow - outflow,
      liquidated,
      totalRepaid: totalRepaidLoanWide,
      seized: seizedLoanWide,
      refunded,
    };
  }
  // Borrower: received principal; paid repayments and any collateral not returned. Unchanged by T8.
  const collateralLost = liquidated ? loan.collateral - refunded : zero;
  const inflow = loan.principal + (liquidated ? refunded : loan.collateral);
  const outflow = totalRepaidLoanWide + loan.collateral;
  return {
    outflow,
    inflow,
    net: inflow - outflow,
    liquidated,
    totalRepaid: totalRepaidLoanWide,
    seized: collateralLost,
    refunded,
  };
}

function header(doc: jsPDF, title: string, meta: StatementMeta, subtitle: string) {
  doc.setFontSize(16);
  doc.text('NexusFi', 14, 16);
  doc.setFontSize(12);
  doc.text(title, 14, 24);
  doc.setFontSize(8);
  doc.setTextColor(110);
  const lines = [
    `Role: ${meta.role}`,
    meta.email ? `Account: ${meta.email}` : null,
    meta.walletAddress ? `Wallet: ${meta.walletAddress}` : null,
    meta.periodLabel ? `Period: ${meta.periodLabel}` : null,
    `Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    'Network: Sepolia testnet — figures are in test ETH and carry no real value.',
    subtitle,
  ].filter(Boolean) as string[];
  lines.forEach((l, i) => doc.text(l, 14, 31 + i * 4));
  doc.setTextColor(0);
  return 31 + lines.length * 4 + 4;
}

// Runs after the tables are laid out, not before: the page count is not known until
// autoTable has finished paginating, and the footer has to say "page i of n".
function footer(doc: jsPDF, estimatedUsed: boolean) {
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(130);
    const note = estimatedUsed
      ? 'USD values use the price captured at each event where available; entries marked (est.) use the current price.'
      : 'USD values use the ETH price captured at the time of each event.';
    doc.text(note, 14, doc.internal.pageSize.getHeight() - 12);
    doc.text(
      `Every row is verifiable on sepolia.etherscan.io by transaction hash.   Page ${i} of ${pages}`,
      14,
      doc.internal.pageSize.getHeight() - 8,
    );
    doc.setTextColor(0);
  }
}

export function generateTradebook(loans: StatementLoan[], meta: StatementMeta): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape' });
  const startY = header(doc, 'Tradebook', meta, 'Every on-chain action, chronologically.');

  let estimated = false;
  const rows = loans
    .flatMap((loan) => {
      // Lender: this lender's own contribution/share/withdrawal/reclaim events,
      // plus the loan's lifecycle events (funded/repaid/liquidated) kept as
      // context (I4) - not other lenders' individual slices - once the loan
      // has per-share data. Borrower rows are unchanged.
      const events =
        meta.role === 'lender'
          ? viewerLedgerEvents(loan.events, meta.walletAddress, { keepLifecycle: true })
          : loan.events;
      return events.map((e) => {
        const p = meta.priceFor(e);
        if (p.estimated) estimated = true;
        return {
          ts: e.timestamp ?? 0,
          row: [
            dt(e.timestamp),
            `#${loan.loanId}`,
            eventLabel(e),
            fmtEth(e.amount),
            p.usd ? `${fmtUsd(ETH(e.amount) * p.usd)}${p.estimated ? ' (est.)' : ''}` : '—',
            e.kind === 'liquidated' && e.refunded !== undefined ? fmtEth(e.refunded) : '',
            e.txHash,
          ],
        };
<<<<<<< HEAD
      }),
    )
    // Sorted across all loans, not within each one: a tradebook is a chronological
    // ledger of what the account did, so two loans running concurrently interleave.
=======
      });
    })
>>>>>>> atharva
    .sort((a, b) => a.ts - b.ts)
    .map((r) => r.row);

  autoTable(doc, {
    startY,
    head: [['Date (UTC)', 'Loan', 'Action', 'ETH', 'USD', 'Refunded ETH', 'Transaction hash']],
    // A placeholder row rather than an empty table, so an account with no activity
    // still produces a document that says so instead of a blank page that reads as a
    // broken export.
    body: rows.length ? rows : [['—', '—', 'No activity yet', '—', '—', '', '']],
    styles: { fontSize: 7, cellPadding: 1.5 },
    headStyles: { fillColor: [15, 23, 42] },
    // Transaction hashes are fixed width and must not wrap: a hash broken across two
    // lines cannot be copied out of the PDF, which defeats the point of printing it.
    columnStyles: { 6: { cellWidth: 90 } },
  });
  footer(doc, estimated);
  return doc;
}

export function generatePnl(loans: StatementLoan[], meta: StatementMeta): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape' });
  const startY = header(
    doc,
    'Profit & Loss',
    meta,
    meta.role === 'lender'
      ? 'Realised result per loan funded.'
      : 'Cost of borrowing per loan taken.',
  );

  const zero = BigInt(0);
  let totalNet = zero;
  const body = loans.map((loan) => {
    const p = computeLoanPnl(loan, meta.role, meta.walletAddress);
    totalNet += p.net;
    return [
      `#${loan.loanId}`,
      loan.statusVal === 4 ? 'Liquidated' : loan.statusVal === 2 ? 'Repaid' : 'Open',
      // Lender's own contribution once per-share data exists (p.outflow),
      // not the whole pool's principal - mirrors pre-pooling behaviour where
      // the two were always equal for a loan's sole lender.
      meta.role === 'lender' ? fmtEth(p.outflow) : fmtEth(loan.principal),
      fmtEth(p.totalRepaid),
      p.liquidated ? fmtEth(p.seized) : '—',
      fmtEth(p.inflow),
      fmtEth(p.outflow),
      // Sign is printed explicitly and the magnitude formatted from the absolute
      // value, so a negative net reads "-0.05" rather than "--0.05" and, more to the
      // point, a positive one is marked "+" rather than left ambiguous.
      `${p.net >= zero ? '+' : '-'}${fmtEth(p.net >= zero ? p.net : -p.net)}`,
      // Net is valued at the current price, unlike the tradebook and tax statements,
      // which value each event at the price when it happened. A net result is a
      // position held now, not a transaction that occurred at a moment, so there is no
      // single historical rate that would be correct for it.
      meta.currentEthUsd
        ? `${p.net >= zero ? '+' : '-'}${fmtUsd(Math.abs(ETH(p.net)) * meta.currentEthUsd)}`
        : '—',
    ];
  });

  autoTable(doc, {
    startY,
    head: [
      [
        'Loan',
        'Status',
        'Principal',
        'Repaid',
        meta.role === 'lender' ? 'Seized' : 'Collateral lost',
        'Total in',
        'Total out',
        'Net ETH',
        'Net USD',
      ],
    ],
    body: body.length ? body : [['—', 'No loans', '—', '—', '—', '—', '—', '—', '—']],
    foot: [[
      'TOTAL', '', '', '', '', '', '',
      `${totalNet >= zero ? '+' : '-'}${fmtEth(totalNet >= zero ? totalNet : -totalNet)}`,
      meta.currentEthUsd
        ? `${totalNet >= zero ? '+' : '-'}${fmtUsd(Math.abs(ETH(totalNet)) * meta.currentEthUsd)}`
        : '—',
    ]],
    styles: { fontSize: 7, cellPadding: 1.5 },
    headStyles: { fillColor: [15, 23, 42] },
    footStyles: { fillColor: [30, 41, 59], textColor: 255 },
  });
  // Always false here: this statement never consults per-event snapshots, so the
  // "(est.)" caveat would be describing a valuation it did not perform.
  footer(doc, false);
  return doc;
}

export function generateTaxPnl(loans: StatementLoan[], meta: StatementMeta): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape' });
  const startY = header(
    doc,
    'Tax P&L',
    meta,
    'Disposals and acquisitions with the ETH/USD rate at the time of each event.',
  );

  let estimated = false;
  const rows = loans
    .flatMap((loan) => {
      // Lender: this lender's own events once the loan has per-share data,
      // not the whole pool's - same fallback rule as computeLoanPnl. Kept
      // strict (no keepLifecycle) - a disposals ledger should list only the
      // viewer's own movements. Borrower rows are unchanged.
      //
      // `withdrawal` is dropped here (C3): a failed push emits a `pending`
      // ShareDistributed AND the amount is recognised as this lender's
      // income right there. The later `withdraw()` just moves that same,
      // already-recognised wei from contract escrow into the wallet - it is
      // not a second acquisition. Counting both doubles the acquisitions
      // total by exactly the pending amount. `withdrawal` stays in the
      // Tradebook (no totals row there, so no double count) as the record of
      // when the money actually arrived.
      const events =
        meta.role === 'lender'
          ? viewerLedgerEvents(loan.events, meta.walletAddress).filter((e) => e.kind !== 'withdrawal')
          : loan.events;
      return events.map((e) => {
        const p = meta.priceFor(e);
        if (p.estimated) estimated = true;
        // Direction is role-relative: what left vs. entered this user's control.
        const inbound =
          meta.role === 'lender'
            ? !OUTBOUND_KINDS.lender.includes(e.kind)
            : e.kind === 'funded' || e.kind === 'liquidated';
        return {
          ts: e.timestamp ?? 0,
          row: [
            dt(e.timestamp),
            `#${loan.loanId}`,
            inbound ? 'Acquisition' : 'Disposal',
            eventLabel(e),
            fmtEth(e.amount),
            p.usd ? `${p.usd.toFixed(2)}${p.estimated ? ' (est.)' : ''}` : '—',
            p.usd ? fmtUsd(ETH(e.amount) * p.usd) : '—',
            e.txHash.slice(0, 20) + '…',
          ],
        };
      });
    })
    .sort((a, b) => a.ts - b.ts)
    .map((r) => r.row);

  autoTable(doc, {
    startY,
    head: [['Date (UTC)', 'Loan', 'Type', 'Event', 'ETH', 'ETH/USD rate', 'Value USD', 'Tx']],
    body: rows.length ? rows : [['—', '—', '—', 'No activity yet', '—', '—', '—', '']],
    styles: { fontSize: 7, cellPadding: 1.5 },
    headStyles: { fillColor: [15, 23, 42] },
  });

  // autoTable attaches lastAutoTable to the document at runtime and does not declare
  // it on jsPDF's type, so the cast is the only way to learn where the table ended and
  // place the disclaimer directly beneath it rather than at a guessed offset.
  const finalY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  doc.setFontSize(7);
  doc.setTextColor(110);
  doc.text(
    'Not tax advice. Sepolia test ETH has no market value; this demonstrates the reporting format only.',
    14,
    finalY + 6,
  );
  doc.setTextColor(0);
  footer(doc, estimated);
  return doc;
}

export function statementFilename(kind: string, role: StatementRole) {
  return `nexusfi-${kind}-${role}-${new Date().toISOString().slice(0, 10)}.pdf`;
}
