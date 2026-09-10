// Shared ABI fragments for the LoanFactory and Loan contracts.
//
// Previously these were hand-copied independently inside LenderDashboard.tsx
// and BorrowerLoansSection.tsx — that duplication is exactly what let the
// Loan ABI go stale when markLiquidatedForDemo() was replaced by liquidate().
// Both components should import from here instead of redefining their own.

export const FACTORY_ABI = [
  {
    name: 'getLoanIds',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256[]' }],
    stateMutability: 'view',
  },
  {
    name: 'loans',
    type: 'function',
    inputs: [{ name: 'loanId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'loanContract', type: 'address' },
          { name: 'borrower', type: 'address' },
          { name: 'principalAmount', type: 'uint256' },
          { name: 'collateralAmount', type: 'uint256' },
          { name: 'durationDays', type: 'uint256' },
          { name: 'interestBps', type: 'uint256' },
          { name: 'maxLtvBps', type: 'uint256' },
          { name: 'liquidationBufferBps', type: 'uint256' },
          { name: 'createdAt', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const;

export const LOAN_ABI = [
  {
    name: 'status',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    name: 'requestedAt',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'contribute',
    type: 'function',
    inputs: [],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    name: 'cancel',
    type: 'function',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'withdraw',
    type: 'function',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'reclaimContribution',
    type: 'function',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'getLenders',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
  },
  {
    name: 'contributions',
    type: 'function',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'totalContributed',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'fundingProgressBps',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'minContribution',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'pendingWithdrawals',
    type: 'function',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'repay',
    type: 'function',
    inputs: [],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    name: 'liquidate',
    type: 'function',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'outstandingBalance',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'totalRepaymentDue',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'repaymentDueAt',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'isDelinquent',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    name: 'isLiquidatable',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    name: 'amountRepaid',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  // --- price-based liquidation ---
  {
    name: 'currentLtvBps',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'liquidationThresholdBps',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'isPriceLiquidatable',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    name: 'isDelinquentLiquidatable',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    name: 'priceAtFunding',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'liquidationPreview',
    type: 'function',
    inputs: [],
    outputs: [
      { name: 'seizeAmount', type: 'uint256' },
      { name: 'refundAmount', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  // --- demo helpers (only usable when the factory has demoMode = true) ---
  {
    name: 'fastForward',
    type: 'function',
    inputs: [{ name: 'secondsToSkip', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'demoMode',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    name: 'borrower',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
] as const;

/// Mock ETH/USD oracle. setPrice is deliberately permissionless on testnet so
/// any teammate can run the price-crash demo.
export const PRICE_FEED_ABI = [
  {
    name: 'latestPrice',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'setPrice',
    type: 'function',
    inputs: [{ name: 'newPrice', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;
