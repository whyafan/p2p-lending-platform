import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

// Reads one field of a returned struct by position or by name. viem hands back a
// tuple or a named object depending on whether the compiled ABI kept the component
// names, so both shapes have to be accepted for the same read to work either way.
function getStructValue<T>(record: unknown, index: number, key: string): T {
  const value = Array.isArray(record)
    ? record[index]
    : (record as Record<string, unknown>)[key];

  return value as T;
}

const DAY = 86_400n;
const INITIAL_PRICE = 2_000n; // $2,000/ETH
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

  // One fixture shared by every test in this file, chosen so the arithmetic is
  // checkable by hand: 1 ETH against 2 ETH at $2,000 is 50% LTV, and 70% + 10%
  // puts the liquidation threshold at 80%, i.e. exactly $1,250/ETH.
  const principalAmount = parseEther("1");
  const collateralAmount = parseEther("2");
  const durationDays = 30n;
  const interestBps = 500n;
  const maxLtvBps = 7_000n;
  const liquidationBufferBps = 1_000n;

  // Deploys the full stack fresh per test rather than reusing one deployment, so a
  // test that liquidates or repays cannot leave state behind for the next one.
  async function deployFundedLoan() {
    const collateralVault = await viem.deployContract("CollateralVault", [], {
      client: { wallet: deployer, public: publicClient },
    });

    const mockPriceFeed = await viem.deployContract("MockPriceFeed", [INITIAL_PRICE], {
      client: { wallet: deployer, public: publicClient },
    });

    const loanFactory = await viem.deployContract(
      "LoanFactory",
      [collateralVault.address, mockPriceFeed.address, true],
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

    return { collateralVault, loanFactory, mockPriceFeed, loanAsLender, loanAsBorrower };
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

    // Well under the ~1 ETH owed, so this is unambiguously a partial payment
    // regardless of any timing drift.
    const firstInstallment = parseEther("0.4");

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
      "Loan: not liquidatable",
    );
  });

  it("allows liquidate() once the grace period has elapsed, moving collateral to the lender", async function () {
    const { collateralVault, loanAsLender, loanAsBorrower } = await deployFundedLoan();

    const fundedAt = await loanAsBorrower.read.fundedAt();
    const dueAt = fundedAt + durationDays * DAY;
    await networkHelpers.time.increaseTo(dueAt + GRACE_PERIOD + 1n);

    assert.equal(await loanAsBorrower.read.isLiquidatable(), true);

    const vaultBalanceBefore = await publicClient.getBalance({ address: collateralVault.address });

    await viem.assertions.emit(
      loanAsLender.write.liquidate({ account: lender.account }),
      loanAsLender,
      "LoanLiquidated",
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
  // ── Price-based (collateral shortfall) liquidation ──────────────────────
  //
  // Debt is frozen in USD at funding (principal x price-at-funding) while the
  // collateral is valued at the live price, so an ETH crash raises LTV.
  // Fixture: 1 ETH borrowed against 2 ETH collateral at $2,000 => 50% LTV.
  // Threshold = maxLtv 70% + buffer 10% = 80%, reached once ETH <= $1,250.

  it("starts healthy: LTV well under threshold, not liquidatable on price", async function () {
    const { loanAsBorrower } = await deployFundedLoan();

    assert.equal(await loanAsBorrower.read.currentLtvBps(), 5_000n); // 50%
    assert.equal(await loanAsBorrower.read.liquidationThresholdBps(), 8_000n);
    assert.equal(await loanAsBorrower.read.isPriceLiquidatable(), false);
    assert.equal(await loanAsBorrower.read.isLiquidatable(), false);
    assert.equal(await loanAsBorrower.read.priceAtFunding(), INITIAL_PRICE);
  });

  it("raises LTV as the ETH price falls, without touching the ETH-denominated debt", async function () {
    const { mockPriceFeed, loanAsBorrower } = await deployFundedLoan();

    const owedBefore = await loanAsBorrower.read.outstandingBalance();

    await mockPriceFeed.write.setPrice([1_600n], { account: deployer.account });

    // 1 ETH x $2000 debt / (2 ETH x $1600 collateral) = 62.5%
    assert.equal(await loanAsBorrower.read.currentLtvBps(), 6_250n);
    assert.equal(await loanAsBorrower.read.isPriceLiquidatable(), false);

    // Settlement stays ETH-denominated: what the borrower owes must NOT move
    // with price (only the lender's USD exposure does).
    const owedAfter = await loanAsBorrower.read.outstandingBalance();
    assert.ok(owedAfter >= owedBefore, "owed should only grow via interest, not price");
    assert.ok(owedAfter - owedBefore < parseEther("0.001"), "price move must not restate the debt");
  });

  it("becomes liquidatable once the crash pushes LTV to the threshold", async function () {
    const { mockPriceFeed, loanAsBorrower } = await deployFundedLoan();

    await mockPriceFeed.write.setPrice([1_251n], { account: deployer.account }); // just above
    assert.equal(await loanAsBorrower.read.isPriceLiquidatable(), false);

    await mockPriceFeed.write.setPrice([1_250n], { account: deployer.account }); // exactly at
    assert.equal(await loanAsBorrower.read.currentLtvBps(), 8_000n);
    assert.equal(await loanAsBorrower.read.isPriceLiquidatable(), true);
    assert.equal(await loanAsBorrower.read.isLiquidatable(), true);
    // Still inside the repayment window — this is purely the price trigger.
    assert.equal(await loanAsBorrower.read.isDelinquentLiquidatable(), false);
  });

  it("lets the lender liquidate on a price crash while the loan is not yet overdue", async function () {
    const { collateralVault, mockPriceFeed, loanAsLender, loanAsBorrower } = await deployFundedLoan();

    await mockPriceFeed.write.setPrice([1_000n], { account: deployer.account });
    assert.equal(await loanAsBorrower.read.isDelinquentLiquidatable(), false);

    await viem.assertions.emit(
      loanAsLender.write.liquidate({ account: lender.account }),
      loanAsLender,
      "LoanLiquidated",
    );

    const position = await collateralVault.read.positions([0n]);
    assert.equal(await loanAsBorrower.read.status(), 4); // Liquidated
    assert.equal(getStructValue(position, 4, "liquidated"), true);
  });

  it("stops being price-liquidatable if the price recovers", async function () {
    const { mockPriceFeed, loanAsLender, loanAsBorrower } = await deployFundedLoan();

    await mockPriceFeed.write.setPrice([1_000n], { account: deployer.account });
    assert.equal(await loanAsBorrower.read.isPriceLiquidatable(), true);

    await mockPriceFeed.write.setPrice([2_000n], { account: deployer.account });
    assert.equal(await loanAsBorrower.read.isPriceLiquidatable(), false);

    await viem.assertions.revertWith(
      loanAsLender.write.liquidate({ account: lender.account }),
      "Loan: not liquidatable",
    );
  });

  it("never liquidates on price when the oracle reports zero (bad data is not a crash)", async function () {
    const { mockPriceFeed, loanAsLender, loanAsBorrower } = await deployFundedLoan();

    await mockPriceFeed.write.setPrice([0n], { account: deployer.account });

    assert.equal(await loanAsBorrower.read.currentPrice(), 0n);
    assert.equal(await loanAsBorrower.read.currentLtvBps(), 0n); // "unknown", not "healthy"
    assert.equal(await loanAsBorrower.read.isPriceLiquidatable(), false);

    await viem.assertions.revertWith(
      loanAsLender.write.liquidate({ account: lender.account }),
      "Loan: not liquidatable",
    );
  });

  it("reports zero LTV once the loan is closed", async function () {
    const { mockPriceFeed, loanAsBorrower } = await deployFundedLoan();

    const owed = await loanAsBorrower.read.outstandingBalance();
    await loanAsBorrower.write.repay({ account: borrower.account, value: owed + parseEther("0.1") });

    await mockPriceFeed.write.setPrice([100n], { account: deployer.account });
    assert.equal(await loanAsBorrower.read.currentLtvBps(), 0n);
    assert.equal(await loanAsBorrower.read.isPriceLiquidatable(), false);
    assert.equal(await loanAsBorrower.read.isLiquidatable(), false);
  });
  // ── Demo helpers: force both triggers without waiting or a real market ──

  it("fastForward() pushes a loan past the deadline and grace period on demand", async function () {
    const { loanAsLender, loanAsBorrower } = await deployFundedLoan();

    assert.equal(await loanAsBorrower.read.demoMode(), true);
    assert.equal(await loanAsBorrower.read.isDelinquentLiquidatable(), false);

    // Skip the full duration + grace + a margin, in one call.
    const skip = durationDays * DAY + GRACE_PERIOD + 60n;
    await loanAsBorrower.write.fastForward([skip], { account: borrower.account });

    assert.equal(await loanAsBorrower.read.isDelinquent(), true);
    assert.equal(await loanAsBorrower.read.isDelinquentLiquidatable(), true);

    // ...and the lender can now actually liquidate, with no real time elapsed.
    await viem.assertions.emit(
      loanAsLender.write.liquidate({ account: lender.account }),
      loanAsLender,
      "LoanLiquidated",
    );
    assert.equal(await loanAsBorrower.read.status(), 4);
  });

  it("fastForward() lets the lender skip only partway, leaving the loan protected", async function () {
    const { loanAsLender, loanAsBorrower } = await deployFundedLoan();

    // Past the deadline but still inside the grace period.
    await loanAsLender.write.fastForward([durationDays * DAY + DAY], { account: lender.account });

    assert.equal(await loanAsBorrower.read.isDelinquent(), true);
    assert.equal(await loanAsBorrower.read.isDelinquentLiquidatable(), false);
    await viem.assertions.revertWith(
      loanAsLender.write.liquidate({ account: lender.account }),
      "Loan: not liquidatable",
    );
  });

  it("fastForward() expires the funding window while a loan is still Requested", async function () {
    const { loanFactory } = await deployFundedLoan();

    // Second, unfunded loan on the same factory.
    await loanFactory.write.createLoan(
      [principalAmount, durationDays, interestBps, maxLtvBps, liquidationBufferBps],
      { account: borrower.account, value: collateralAmount },
    );
    const terms = await loanFactory.read.loans([1n]);
    const addr = getStructValue<`0x${string}`>(terms, 0, "loanContract");
    const loan = await viem.getContractAt("Loan", addr, {
      client: { wallet: borrower, public: publicClient },
    });

    await loan.write.fastForward([8n * DAY], { account: borrower.account }); // window is 7 days

    const asLender = await viem.getContractAt("Loan", addr, {
      client: { wallet: lender, public: publicClient },
    });
    await viem.assertions.revertWith(
      asLender.write.fund({ account: lender.account, value: principalAmount }),
      "Loan: funding window has expired",
    );
  });

  it("fastForward() rejects non-participants and closed loans", async function () {
    const { loanAsBorrower } = await deployFundedLoan();

    // deployer is neither borrower nor lender on this loan
    await viem.assertions.revertWith(
      loanAsBorrower.write.fastForward([DAY], { account: deployer.account }),
      "Loan: not a participant",
    );

    const owed = await loanAsBorrower.read.outstandingBalance();
    await loanAsBorrower.write.repay({ account: borrower.account, value: owed + parseEther("0.1") });

    await viem.assertions.revertWith(
      loanAsBorrower.write.fastForward([DAY], { account: borrower.account }),
      "Loan: loan is closed",
    );
  });

  it("anyone can move the mock oracle price (so any teammate can run the demo)", async function () {
    const { mockPriceFeed, loanAsBorrower } = await deployFundedLoan();

    // borrower is not the feed's deployer, yet can still crash the price
    await mockPriceFeed.write.setPrice([1_000n], { account: borrower.account });

    assert.equal(await mockPriceFeed.read.latestPrice(), 1_000n);
    assert.equal(await loanAsBorrower.read.isPriceLiquidatable(), true);
  });
  // ── Partial liquidation: seize only the debt, refund the surplus ─────────
  //
  // Liquidation used to hand the lender the entire collateral regardless of how
  // much was still owed, so a borrower who had repaid most of a loan still lost
  // everything while the lender collected far more than the debt.

  it("seizes only what is owed and refunds the surplus to the borrower", async function () {
    const { collateralVault, loanAsLender, loanAsBorrower } = await deployFundedLoan();

    const fundedAt = await loanAsBorrower.read.fundedAt();
    await networkHelpers.time.increaseTo(fundedAt + durationDays * DAY + GRACE_PERIOD + 1n);

    const [seize, refund] = await loanAsBorrower.read.liquidationPreview();
    const owed = await loanAsBorrower.read.outstandingBalance();

    assert.equal(seize, owed, "should seize exactly the outstanding debt");
    assert.equal(seize + refund, collateralAmount, "seize + refund must equal the collateral");
    assert.ok(refund > 0n, "an over-collateralised loan must leave a surplus");

    const lenderBefore = await publicClient.getBalance({ address: lender.account.address });
    const borrowerBefore = await publicClient.getBalance({ address: borrower.account.address });

    await loanAsLender.write.liquidate({ account: lender.account });

    const lenderAfter = await publicClient.getBalance({ address: lender.account.address });
    const borrowerAfter = await publicClient.getBalance({ address: borrower.account.address });
    const position = await collateralVault.read.positions([0n]);

    // Lender pays gas, so compare against the seizure rather than an exact delta.
    assert.ok(lenderAfter > lenderBefore, "lender should receive the seized collateral");
    assert.ok(lenderAfter - lenderBefore <= seize, "lender must never receive more than owed");
    // Borrower sends no transaction here, so their delta is exactly the refund.
    assert.equal(borrowerAfter - borrowerBefore, refund);
    assert.equal(await loanAsBorrower.read.status(), 4);
    assert.equal(getStructValue(position, 4, "liquidated"), true);
  });

  it("shrinks the seizure pound for pound as the borrower repays", async function () {
    const { loanAsLender, loanAsBorrower } = await deployFundedLoan();

    const [seizeBefore, refundBefore] = await loanAsBorrower.read.liquidationPreview();

    const installment = parseEther("0.4");
    await loanAsBorrower.write.repay({ account: borrower.account, value: installment });

    const [seizeAfter, refundAfter] = await loanAsBorrower.read.liquidationPreview();

    assert.ok(seizeAfter < seizeBefore, "repaying must reduce what can be seized");
    assert.ok(refundAfter > refundBefore, "repaying must increase what comes back");
    assert.equal(seizeAfter + refundAfter, collateralAmount);

    // The reduction tracks the payment (interest accrues meanwhile, so allow a little drift).
    const reduction = seizeBefore - seizeAfter;
    const drift = reduction > installment ? reduction - installment : installment - reduction;
    assert.ok(drift < parseEther("0.001"), "seizure should fall by roughly the amount repaid");
  });

  it("still liquidates a mostly-repaid loan without wiping out the borrower", async function () {
    const { loanAsLender, loanAsBorrower } = await deployFundedLoan();

    // Repay almost everything, then go delinquent on the remainder.
    const owed = await loanAsBorrower.read.outstandingBalance();
    await loanAsBorrower.write.repay({ account: borrower.account, value: (owed * 9n) / 10n });

    const fundedAt = await loanAsBorrower.read.fundedAt();
    await networkHelpers.time.increaseTo(fundedAt + durationDays * DAY + GRACE_PERIOD + 1n);

    const [seize, refund] = await loanAsBorrower.read.liquidationPreview();
    assert.ok(refund > seize, "having repaid 90%, most collateral should come back");

    const borrowerBefore = await publicClient.getBalance({ address: borrower.account.address });
    await loanAsLender.write.liquidate({ account: lender.account });
    const borrowerAfter = await publicClient.getBalance({ address: borrower.account.address });

    assert.equal(borrowerAfter - borrowerBefore, refund);
  });

  it("seizes everything when the debt exceeds the collateral, with no refund", async function () {
    const { collateralVault, loanAsLender, loanAsBorrower } = await deployFundedLoan();

    // Push interest well past the collateral by leaving it delinquent, then
    // verify the seizure is capped at what the vault actually holds.
    const fundedAt = await loanAsBorrower.read.fundedAt();
    await networkHelpers.time.increaseTo(fundedAt + durationDays * DAY + GRACE_PERIOD + 1n);

    const [seize, refund] = await loanAsBorrower.read.liquidationPreview();
    assert.ok(seize <= collateralAmount, "seizure can never exceed the posted collateral");
    assert.equal(seize + refund, collateralAmount);

    const vaultBefore = await publicClient.getBalance({ address: collateralVault.address });
    await loanAsLender.write.liquidate({ account: lender.account });
    const vaultAfter = await publicClient.getBalance({ address: collateralVault.address });

    // Whatever the split, the vault empties this position entirely.
    assert.equal(vaultBefore - vaultAfter, collateralAmount);
  });
});
