export const FACTORY_ABI = [
  {
    type: 'event',
    name: 'LoanCreated',
    inputs: [
      { name: 'loanId', type: 'uint256', indexed: true },
      { name: 'borrower', type: 'address', indexed: true },
      { name: 'loanContract', type: 'address', indexed: true },
      { name: 'principalAmount', type: 'uint256', indexed: false },
      { name: 'collateralAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'createLoan',
    stateMutability: 'payable',
    inputs: [
      { name: 'principalAmount', type: 'uint256' },
      { name: 'durationDays', type: 'uint256' },
      { name: 'interestBps', type: 'uint256' },
      { name: 'maxLtvBps', type: 'uint256' },
      { name: 'liquidationBufferBps', type: 'uint256' },
    ],
    outputs: [
      { name: 'loanId', type: 'uint256' },
      { name: 'loanContract', type: 'address' },
    ],
  },
  {
    type: 'function',
    name: 'loans',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [
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
  {
    type: 'function',
    name: 'getLoanCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getLoanIds',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256[]' }],
  },
] as const;

export const LOAN_ABI = [
  {
    type: 'function',
    name: 'fund',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'repay',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'cancel',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'status',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'totalRepaymentDue',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'interestDue',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'principalAmount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'collateralAmount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'LoanRepaid',
    inputs: [
      { name: 'loanId', type: 'uint256', indexed: true },
      { name: 'borrower', type: 'address', indexed: true },
      { name: 'repaymentAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LoanCancelled',
    inputs: [{ name: 'loanId', type: 'uint256', indexed: true }],
  },
  {
    type: 'function',
    name: 'markLiquidatedForDemo',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'event',
    name: 'LoanLiquidated',
    inputs: [
      { name: 'loanId', type: 'uint256', indexed: true },
      { name: 'lender', type: 'address', indexed: true },
    ],
  },
  {
    type: 'function',
    name: 'lender',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export const PRICE_FEED_ABI = [
  {
    type: 'function',
    name: 'ethUsdPrice',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'setPrice',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newPrice', type: 'uint256' }],
    outputs: [],
  },
] as const;
