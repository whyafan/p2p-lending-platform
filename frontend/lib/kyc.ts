export const KYC_STATUSES = [
  'NOT_STARTED',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'MANUAL_REVIEW',
  'EXPIRED',
] as const;

export type KycStatus = (typeof KYC_STATUSES)[number];

export function isKycApproved(status: string | null | undefined): boolean {
  return status === 'APPROVED';
}

export function kycStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Not started';
  return status
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
