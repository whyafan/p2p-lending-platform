import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

function getStructValue<T>(record: unknown, index: number, key: string): T {
  const value = Array.isArray(record)
    ? record[index]
    : (record as Record<string, unknown>)[key];

  return value as T;
}

const DAY = 86_400n;
const GRACE_PERIOD = 2n * DAY;
const BPS_DENOMINATOR = 10_000n;
const YEAR_DAYS = 365n;

// Mirrors Loan.sol's interestDue() formula: principal * interestBps * elapsedSeconds
// / (10_000 * 365 days). At elapsedSeconds == durationDays * 1 days this is
// algebraically identical to the old fixed-duration formula.
function expectedInterest(
  principalAmount: bigint,
  interestBps: bigint,
  elapsedSeconds: bigint,
): bigint {
  return (principalAmount * interestBps * elapsedSeconds) / (BPS_DENOMINATOR * YEAR_DAYS * DAY);
}

describe("Loan lifecycle: repayment deadlines, partial repayment, liquidation", async function () {
  const { viem, networkHelpers } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, borrower, lender] = await viem.getWalletClients();

  const principalAmount = parseEther("5");
  const collateralAmount = parseEther("2");
  const durationDays = 30n;
  const interestBps = 500n;
  const maxLtvBps = 7_000n;
  const liquidationBufferBps = 1_000n;

  async function deployFundedLoan() {
    const collateralVault = await viem.deployContract("CollateralVault", [], {
      client: { wallet: deployer, public: publicClient },
    });

    const loanFactory = await viem.deployContract(
      "LoanFactory",
      [collateralVault.address],
      { client: { wallet: deployer, public: publicClient } },
    );

    await collateralVault.write.setFactory([loanFactory.address], {
      account: deployer.account,
    });

    await loanFactory.write.createLoan(
      [principalAmount, durationDays, interestBps, maxLtvBps, liquidationBufferBps],
      { account: borrower.account, value: collateralAmount },
    );

    const loanTerms = await loanFactory.read.loans([0n]);
    const loanAddress = getStructValue<`0x${string}`>(loanTerms, 0, "loanContract");

    const loanAsLender = await viem.getContractAt("Loan", loanAddress, {
      client: { wallet: lender, public: publicClient },
    });
    const loanAsBorrower = await viem.getContractAt("Loan", loanAddress, {
      client: { wallet: borrower, public: publicClient },
    });

    await loanAsLender.write.fund({ account: lender.account, value: principalAmount });

    return { collateralVault, loanFactory, loanAsLender, loanAsBorrower };
  }

  // NOTE on timing: Hardhat's EDR network timestamps auto-mined blocks using
  // real wall-clock time, and interestDue()/outstandingBalance() are now
  // genuinely time-sensitive down to the second. A value read moments before
  // sending a transaction can go stale by the time that transaction actually
  // mines. These tests therefore avoid asserting against a pre-computed exact
  // "owed" figure for anything time-sensitive — instead they use flat,
  // deliberately-safe amounts (well clear of any realistic drift) and verify
  // outcomes by reading authoritative contract state *after* each transaction.

  it("supports partial repayments across multiple installments and releases collateral on the final one", async function () {
    const { collateralVault, loanAsLender, loanAsBorrower } = await deployFundedLoan();

    // Well under the ~5+ ETH owed, so this is unambiguously a partial payment
    // regardless of any timing drift.
    const firstInstallment = parseEther("1");

    const lenderBalanceBefore1 = await publicClient.getBalance({ address: lender.account.address });
    await viem.assertions.emit(
      loanAsBorrower.write.repay({ account: borrower.account, value: firstInstallment }),
      loanAsBorrower,
      "PartialRepayment",
    );
    const lenderBalanceAfter1 = await publicClient.getBalance({ address: lender.account.address });

    assert.equal(lenderBalanceAfter1 - lenderBalanceBefore1, firstInstallment);
    assert.equal(await loanAsBorrower.read.status(), 1); // still Funded
    assert.equal(await loanAsBorrower.read.amountRepaid(), firstInstallment);

    // Pay off the rest with a generous buffer over whatever's currently owed,
    // so this is unambiguously the completing payment regardless of drift —
    // the contract must cap `applied` at the live owed and refund the rest.
    const roughlyOwed = await loanAsBorrower.read.outstandingBalance();
    const lenderBalanceBefore2 = await publicClient.getBalance({ address: lender.account.address });

    await viem.assertions.emit(
      loanAsBorrower.write.repay({ account: borrower.account, value: roughlyOwed + parseEther("0.1") }),
      loanAsBorrower,
      "LoanRepaid",
    );

    const lenderBalanceAfter2 = await publicClient.getBalance({ address: lender.account.address });
    const amountRepaidFinal = await loanAsBorrower.read.amountRepaid();
    const position = await collateralVault.read.positions([0n]);

    // Whatever the contract actually applied on this call (amountRepaidFinal
    // minus what was already repaid) is exactly what the lender received.
    assert.equal(lenderBalanceAfter2 - lenderBalanceBefore2, amountRepaidFinal - firstInstallment);
    assert.equal(await loanAsBorrower.read.status(), 2); // Repaid
    assert.equal(await loanAsBorrower.read.outstandingBalance(), 0n);
    assert.equal(getStructValue(position, 3, "released"), true);
  });

  it("supports one-shot full repayment in a single call (regression)", async function () {
    const { collateralVault, loanAsBorrower } = await deployFundedLoan();

    const roughlyOwed = await loanAsBorrower.read.outstandingBalance();
    await loanAsBorrower.write.repay({ account: borrower.account, value: roughlyOwed + parseEther("0.1") });

    const position = await collateralVault.read.positions([0n]);
    assert.equal(await loanAsBorrower.read.status(), 2); // Repaid
    assert.equal(await loanAsBorrower.read.outstandingBalance(), 0n);
    assert.equal(getStructValue(position, 3, "released"), true);
  });

  it("refunds the excess when the completing payment overpays", async function () {
    const { loanAsBorrower } = await deployFundedLoan();

    const roughlyOwed = await loanAsBorrower.read.outstandingBalance();
    const sentValue = roughlyOwed + parseEther("0.1"); // deliberately overpays

    const lenderBalanceBefore = await publicClient.getBalance({ address: lender.account.address });
    const borrowerBalanceBefore = await publicClient.getBalance({ address: borrower.account.address });

    const hash = await loanAsBorrower.write.repay({ account: borrower.account, value: sentValue });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;

    // First and only payment, so amountRepaid() is exactly what was "applied"
    // (i.e. the live owed amount at execution) — read after the fact rather
    // than predicted, since it's time-sensitive.
    const applied = await loanAsBorrower.read.amountRepaid();
    const expectedRefund = sentValue - applied;

    const lenderBalanceAfter = await publicClient.getBalance({ address: lender.account.address });
    const borrowerBalanceAfter = await publicClient.getBalance({ address: borrower.account.address });

    assert.ok(expectedRefund > 0n, "test setup should have produced a real overpayment");
    assert.equal(lenderBalanceAfter - lenderBalanceBefore, applied);
    // Borrower's net balance change is independently measured from the chain.
    // This is the completing payment, so the borrower both gets the refund
    // (implicitly, via sentValue - applied not leaving their pocket) AND the
    // collateral released back to them in the same transaction: net change is
    // -(applied) - gas + collateralAmount. This only holds if the contract
    // correctly refunded the excess.
    assert.equal(borrowerBalanceAfter - borrowerBalanceBefore, -applied - gasCost + collateralAmount);
    assert.equal(await loanAsBorrower.read.status(), 2); // Repaid
  });

  it("computes interest matching the fixed-duration formula exactly at the deadline boundary", async function () {
    const { loanAsBorrower } = await deployFundedLoan();

    const fundedAt = await loanAsBorrower.read.fundedAt();
    const dueAt = fundedAt + durationDays * DAY;

    await networkHelpers.time.increaseTo(dueAt);

    const elapsedSeconds = durationDays * DAY;
    const expected = expectedInterest(principalAmount, interestBps, elapsedSeconds);

    assert.equal(await loanAsBorrower.read.interestDue(), expected);
    assert.equal(await loanAsBorrower.read.isDelinquent(), false);
  });

  it("keeps accruing interest past the deadline, strictly larger than the boundary value", async function () {
    const { loanAsBorrower } = await deployFundedLoan();

    const fundedAt = await loanAsBorrower.read.fundedAt();
    const dueAt = fundedAt + durationDays * DAY;

    await networkHelpers.time.increaseTo(dueAt);
    const interestAtDeadline = await loanAsBorrower.read.interestDue();

    await networkHelpers.time.increaseTo(dueAt + DAY);
    const interestOneDayLate = await loanAsBorrower.read.interestDue();

    assert.ok(interestOneDayLate > interestAtDeadline);
    assert.equal(await loanAsBorrower.read.isDelinquent(), true);
    assert.equal(await loanAsBorrower.read.isLiquidatable(), false); // grace period is 2 days
  });

  it("caps interest accrual once the loan becomes liquidatable, even if more time passes", async function () {
    const { loanAsBorrower } = await deployFundedLoan();

    const fundedAt = await loanAsBorrower.read.fundedAt();
    const capTimestamp = fundedAt + durationDays * DAY + GRACE_PERIOD;

    await networkHelpers.time.increaseTo(capTimestamp);
    const interestAtCap = await loanAsBorrower.read.interestDue();

    await networkHelpers.time.increaseTo(capTimestamp + 30n * DAY);
    const interestMuchLater = await loanAsBorrower.read.interestDue();

    assert.equal(interestMuchLater, interestAtCap);
    assert.equal(await loanAsBorrower.read.status(), 1); // still Funded — nobody liquidated it
  });

  it("reverts liquidate() before the grace period has elapsed", async function () {
    const { loanAsLender, loanAsBorrower } = await deployFundedLoan();

    const fundedAt = await loanAsBorrower.read.fundedAt();
    const dueAt = fundedAt + durationDays * DAY;
    await networkHelpers.time.increaseTo(dueAt + DAY); // 1 day late, grace is 2 days

    assert.equal(await loanAsBorrower.read.isLiquidatable(), false);
    await viem.assertions.revertWith(
      loanAsLender.write.liquidate({ account: lender.account }),
      "Loan: grace period not elapsed",
    );
  });

  it("allows liquidate() once the grace period has elapsed, moving collateral to the lender", async function () {
    const { collateralVault, loanAsLender, loanAsBorrower } = await deployFundedLoan();

    const fundedAt = await loanAsBorrower.read.fundedAt();
    const dueAt = fundedAt + durationDays * DAY;
    await networkHelpers.time.increaseTo(dueAt + GRACE_PERIOD + 1n);

    assert.equal(await loanAsBorrower.read.isLiquidatable(), true);

    const vaultBalanceBefore = await publicClient.getBalance({ address: collateralVault.address });

    await viem.assertions.emitWithArgs(
      loanAsLender.write.liquidate({ account: lender.account }),
      loanAsLender,
      "LoanLiquidated",
      [0n, getAddress(lender.account.address)],
    );

    const vaultBalanceAfter = await publicClient.getBalance({ address: collateralVault.address });
    const position = await collateralVault.read.positions([0n]);

    assert.equal(await loanAsBorrower.read.status(), 4); // Liquidated
    assert.equal(getStructValue(position, 4, "liquidated"), true);
    assert.equal(vaultBalanceBefore - vaultBalanceAfter, collateralAmount);
  });

  it("reverts liquidate() if the loan is already Repaid, even after time has passed", async function () {
    const { loanAsLender, loanAsBorrower } = await deployFundedLoan();

    const roughlyOwed = await loanAsBorrower.read.outstandingBalance();
    await loanAsBorrower.write.repay({ account: borrower.account, value: roughlyOwed + parseEther("0.1") });
    assert.equal(await loanAsBorrower.read.status(), 2); // confirm it actually closed as Repaid

    const fundedAt = await loanAsBorrower.read.fundedAt();
    await networkHelpers.time.increaseTo(fundedAt + durationDays * DAY + GRACE_PERIOD + 100n);

    await viem.assertions.revertWith(
      loanAsLender.write.liquidate({ account: lender.account }),
      "Loan: not active",
    );
  });

  it("reverts liquidate() if called by a non-lender", async function () {
    const { loanAsBorrower } = await deployFundedLoan();

    const fundedAt = await loanAsBorrower.read.fundedAt();
    await networkHelpers.time.increaseTo(fundedAt + durationDays * DAY + GRACE_PERIOD + 1n);

    // borrower is not the lender on this loan
    await viem.assertions.revertWith(
      loanAsBorrower.write.liquidate({ account: borrower.account }),
      "Loan: caller is not lender",
    );
  });
});
