import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { parseEther } from "viem";

function getStructValue<T>(record: unknown, index: number, key: string): T {
  const value = Array.isArray(record)
    ? record[index]
    : (record as Record<string, unknown>)[key];
  return value as T;
}

const INITIAL_PRICE = 2_000n;

describe("Multi-lender repayment settlement", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, borrower, lenderA, lenderB, lenderC] = await viem.getWalletClients();

  const principalAmount = parseEther("1");
  const collateralAmount = parseEther("2");
  const durationDays = 30n;
  const interestBps = 500n;
  const maxLtvBps = 7_000n;
  const liquidationBufferBps = 1_000n;

  async function deployRequestedLoan() {
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
    await collateralVault.write.setFactory([loanFactory.address], { account: deployer.account });
    await loanFactory.write.createLoan(
      [principalAmount, durationDays, interestBps, maxLtvBps, liquidationBufferBps],
      { account: borrower.account, value: collateralAmount },
    );
    const terms = await loanFactory.read.loans([0n]);
    const loanAddress = getStructValue<`0x${string}`>(terms, 0, "loanContract");
    const loan = await viem.getContractAt("Loan", loanAddress, {
      client: { wallet: deployer, public: publicClient },
    });
    return { collateralVault, loanFactory, mockPriceFeed, loan, loanAddress };
  }

  // NOTE on timing (see LoanLifecycle.ts lines 83-90): never assert against a
  // pre-computed exact "owed" figure. interestDue()/outstandingBalance() are
  // time-sensitive down to the second, so these tests read authoritative
  // state after each transaction instead of predicting it beforehand.

  it("splits a partial repayment pro-rata across two lenders, summing exactly", async function () {
    const { loan } = await deployRequestedLoan();
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.6") });
    await loan.write.contribute({ account: lenderB.account, value: parseEther("0.4") });

    const installment = parseEther("0.5"); // well under owed
    const aBefore = await publicClient.getBalance({ address: lenderA.account.address });
    const bBefore = await publicClient.getBalance({ address: lenderB.account.address });

    await loan.write.repay({ account: borrower.account, value: installment });

    const aAfter = await publicClient.getBalance({ address: lenderA.account.address });
    const bAfter = await publicClient.getBalance({ address: lenderB.account.address });

    // A holds 60% of the pool, B 40%; B is last in the array so B absorbs dust.
    const aShare = (installment * parseEther("0.6")) / parseEther("1");
    assert.equal(aAfter - aBefore, aShare);
    assert.equal(bAfter - bBefore, installment - aShare);
  });

  it("full repayment gives each lender contribution plus pro-rata interest, exact sum", async function () {
    const { loan, loanAddress } = await deployRequestedLoan();
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.7") });
    await loan.write.contribute({ account: lenderB.account, value: parseEther("0.3") });

    const aBefore = await publicClient.getBalance({ address: lenderA.account.address });
    const bBefore = await publicClient.getBalance({ address: lenderB.account.address });

    const roughlyOwed = await loan.read.outstandingBalance();
    await loan.write.repay({ account: borrower.account, value: roughlyOwed + parseEther("0.1") });

    const applied = await loan.read.amountRepaid();
    const aAfter = await publicClient.getBalance({ address: lenderA.account.address });
    const bAfter = await publicClient.getBalance({ address: lenderB.account.address });

    const aShare = (applied * parseEther("0.7")) / parseEther("1");
    assert.equal(aAfter - aBefore, aShare);
    assert.equal(bAfter - bBefore, applied - aShare); // exact-sum: dust to last lender
    assert.ok(aAfter - aBefore > parseEther("0.7"), "A must earn interest on top of principal");
    assert.equal(await loan.read.status(), 2); // Repaid
    // No wei stranded on the loan contract after full settlement.
    assert.equal(await publicClient.getBalance({ address: loanAddress }), 0n);
  });

  it("three lenders: distributed shares sum exactly to the applied amount", async function () {
    const { loan } = await deployRequestedLoan();
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.5") });
    await loan.write.contribute({ account: lenderB.account, value: parseEther("0.3") });
    await loan.write.contribute({ account: lenderC.account, value: parseEther("0.2") });

    // Deliberately odd wei amount, well under owed, so the pro-rata split does
    // not divide evenly and real rounding dust exists.
    const installment = 333333333333333337n;

    const aBefore = await publicClient.getBalance({ address: lenderA.account.address });
    const bBefore = await publicClient.getBalance({ address: lenderB.account.address });
    const cBefore = await publicClient.getBalance({ address: lenderC.account.address });

    await loan.write.repay({ account: borrower.account, value: installment });

    const aAfter = await publicClient.getBalance({ address: lenderA.account.address });
    const bAfter = await publicClient.getBalance({ address: lenderB.account.address });
    const cAfter = await publicClient.getBalance({ address: lenderC.account.address });

    // A holds 50%, B 30%; both are non-last and get an exact floor share. C is
    // last in the array, so C absorbs whatever dust the floors leave behind.
    const aShare = (installment * parseEther("0.5")) / parseEther("1");
    const bShare = (installment * parseEther("0.3")) / parseEther("1");
    const cShare = installment - aShare - bShare;

    assert.equal(aAfter - aBefore, aShare);
    assert.equal(bAfter - bBefore, bShare);
    assert.equal(cAfter - cBefore, cShare);
    // No wei created or destroyed by the split: the three deltas sum to
    // exactly the applied amount.
    assert.equal((aAfter - aBefore) + (bAfter - bBefore) + (cAfter - cBefore), installment);
    // Confirm this installment really does produce dust, i.e. the naive floor
    // for C's own 20% share would differ from what C actually received.
    const naiveCShare = (installment * parseEther("0.2")) / parseEther("1");
    assert.notEqual(cShare, naiveCShare);
  });

  it("a reverting contract lender is credited, not able to block repayment", async function () {
    const { loan, loanAddress } = await deployRequestedLoan();
    const rejecting = await viem.deployContract("RejectingReceiver", [], {
      client: { wallet: deployer, public: publicClient },
    });
    await rejecting.write.contributeTo([loanAddress], { account: deployer.account, value: parseEther("0.4") });
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.6") });

    // accept stays false: pushes to it revert, so its share must be credited.
    const roughlyOwed = await loan.read.outstandingBalance();
    await loan.write.repay({ account: borrower.account, value: roughlyOwed + parseEther("0.1") });

    assert.equal(await loan.read.status(), 2); // repayment was NOT blocked
    const credited = await loan.read.pendingWithdrawals([rejecting.address]);
    assert.ok(credited > 0n, "failed push must be credited for withdrawal");

    // Arm the receiver, withdraw, and verify the credit pays out in full.
    await rejecting.write.setAccept([true], { account: deployer.account });
    const rBefore = await publicClient.getBalance({ address: rejecting.address });
    await rejecting.write.withdrawFrom([loanAddress], { account: deployer.account });
    const rAfter = await publicClient.getBalance({ address: rejecting.address });
    assert.equal(rAfter - rBefore, credited);
    assert.equal(await loan.read.pendingWithdrawals([rejecting.address]), 0n);
  });

  it("withdraw() with nothing pending reverts", async function () {
    const { loan } = await deployRequestedLoan();
    await viem.assertions.revertWith(
      loan.write.withdraw({ account: lenderA.account }),
      "Loan: nothing to withdraw",
    );
  });

  it("overpayment on the completing payment still refunds the borrower", async function () {
    const { loan } = await deployRequestedLoan();
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.7") });
    await loan.write.contribute({ account: lenderB.account, value: parseEther("0.3") });

    const roughlyOwed = await loan.read.outstandingBalance();
    const sentValue = roughlyOwed + parseEther("0.1"); // deliberately overpays

    const borrowerBefore = await publicClient.getBalance({ address: borrower.account.address });

    const hash = await loan.write.repay({ account: borrower.account, value: sentValue });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;

    // First and only payment, so amountRepaid() is exactly what was "applied"
    // (i.e. the live owed amount at execution) - read after the fact rather
    // than predicted, since it's time-sensitive.
    const applied = await loan.read.amountRepaid();
    const expectedRefund = sentValue - applied;

    const borrowerAfter = await publicClient.getBalance({ address: borrower.account.address });

    assert.ok(expectedRefund > 0n, "test setup should have produced a real overpayment");
    // This is the completing payment, so the borrower gets the refund
    // (implicitly, via sentValue - applied not leaving their pocket) AND the
    // collateral released back to them in the same transaction: net change is
    // -(applied) - gas + collateralAmount. This only holds if the contract
    // correctly refunded the excess.
    assert.equal(borrowerAfter - borrowerBefore, -applied - gasCost + collateralAmount);
    assert.equal(await loan.read.status(), 2); // Repaid
  });

  it("measures real distribution gas at the lender cap", async function () {
    const { loan } = await deployRequestedLoan();
    const allWallets = await viem.getWalletClients();
    const nonBorrowerWallets = allWallets.filter(
      (w) => w.account.address.toLowerCase() !== borrower.account.address.toLowerCase(),
    );
    assert.ok(nonBorrowerWallets.length >= 10, "need at least 10 non-borrower wallets");

    // 10 distinct contributors, each funding an equal 1/10 share of principal.
    const share = principalAmount / 10n;
    for (let i = 0; i < 10; i++) {
      await loan.write.contribute({ account: nonBorrowerWallets[i].account, value: share });
    }
    assert.equal(await loan.read.status(), 1); // Funded
    assert.equal((await loan.read.getLenders()).length, 10);

    const roughlyOwed = await loan.read.outstandingBalance();
    const hash = await loan.write.repay({ account: borrower.account, value: roughlyOwed + parseEther("0.1") });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    console.log(`10-lender repay gasUsed: ${receipt.gasUsed}`);
    assert.ok(
      receipt.gasUsed < 2_000_000n,
      `distribution across the full 10-lender cap must stay well under a safe bound, got ${receipt.gasUsed}`,
    );
    assert.equal(await loan.read.status(), 2); // Repaid
  });

  it("a well-behaved contract wallet still gets an instant push, not the fallback", async function () {
    const { loan, loanAddress } = await deployRequestedLoan();
    const receiver = await viem.deployContract("RejectingReceiver", [], {
      client: { wallet: deployer, public: publicClient },
    });
    await receiver.write.setAccept([true], { account: deployer.account }); // armed to accept
    await receiver.write.contributeTo([loanAddress], { account: deployer.account, value: parseEther("0.4") });
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.6") });

    const receiverBefore = await publicClient.getBalance({ address: receiver.address });

    const roughlyOwed = await loan.read.outstandingBalance();
    const hash = await loan.write.repay({ account: borrower.account, value: roughlyOwed + parseEther("0.1") });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const receiverAfter = await publicClient.getBalance({ address: receiver.address });
    assert.ok(receiverAfter > receiverBefore, "armed receiver should have received a pushed share");

    const events = await publicClient.getContractEvents({
      address: loanAddress,
      abi: loan.abi,
      eventName: "ShareDistributed",
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });
    const receiverEvent = events.find(
      (e) => (e.args as { lender?: string }).lender?.toLowerCase() === receiver.address.toLowerCase(),
    );
    assert.ok(receiverEvent, "expected a ShareDistributed event for the armed receiver");
    assert.equal((receiverEvent!.args as { pending?: boolean }).pending, false);
    // Instant push, not the pull-fallback path.
    assert.equal(await loan.read.pendingWithdrawals([receiver.address]), 0n);
  });
});
