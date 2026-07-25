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
    name: 'lender',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    name: 'fund',
    type: 'function',
    inputs: [],
    outputs: [],
    stateMutability: 'payable',
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
] as const;
