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
const DAY = 86_400n;
const GRACE_PERIOD = 2n * DAY;

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

  // Reads the actual seized/refunded amounts from the LoanLiquidated event
  // emitted by the liquidate() transaction at blockNumber, rather than from a
  // pre-transaction liquidationPreview() - interest accrues per second, so
  // only post-transaction state is authoritative.
  async function getLiquidatedEvent(
    loanAddress: `0x${string}`,
    abi: unknown,
    blockNumber: bigint,
  ) {
    const events = await publicClient.getContractEvents({
      address: loanAddress,
      abi: abi as never,
      eventName: "LoanLiquidated",
      fromBlock: blockNumber,
      toBlock: blockNumber,
    });
    return events[0].args as {
      lender: string;
      seizedAmount: bigint;
      refundedToBorrower: bigint;
    };
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
    const { loan, loanAddress } = await deployRequestedLoan();
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
    // Independent guards: this is a partial payment, so the loan stays Funded,
    // and a fully-pushed distribution must leave no wei stranded on the contract.
    assert.equal(await loan.read.status(), 1); // Funded
    assert.equal(await publicClient.getBalance({ address: loanAddress }), 0n);
  });

  it("a reverting contract lender is credited, not able to block repayment", async function () {
    const { loan, loanAddress } = await deployRequestedLoan();
    const rejecting = await viem.deployContract("RejectingReceiver", [], {
      client: { wallet: deployer, public: publicClient },
    });
    // rejecting contributes first, so it is _lenders[0], NOT the last lender:
    // its share is an exact floor, with no dust, independently computable.
    await rejecting.write.contributeTo([loanAddress], { account: deployer.account, value: parseEther("0.4") });
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.6") });

    const aBefore = await publicClient.getBalance({ address: lenderA.account.address });

    // accept stays false: pushes to it revert, so its share must be credited.
    const roughlyOwed = await loan.read.outstandingBalance();
    await loan.write.repay({ account: borrower.account, value: roughlyOwed + parseEther("0.1") });

    assert.equal(await loan.read.status(), 2); // repayment was NOT blocked

    // Independently compute the expected share instead of trusting the
    // contract's own recorded value: read the authoritative applied amount
    // after the fact (time-sensitive interest) and floor it against
    // rejecting's known 0.4 ETH contribution out of the 1 ETH principal.
    const applied = await loan.read.amountRepaid();
    const expectedShare = (applied * parseEther("0.4")) / parseEther("1");

    const credited = await loan.read.pendingWithdrawals([rejecting.address]);
    assert.ok(credited > 0n, "failed push must be credited for withdrawal");
    assert.equal(credited, expectedShare, "credited amount must equal the independently computed exact floor");

    // The well-behaved EOA co-lender (lenderA, last in the array) must still
    // be paid its full share by push in the same transaction, despite
    // rejecting's push failing: its delta is exactly applied - credited.
    const aAfter = await publicClient.getBalance({ address: lenderA.account.address });
    assert.equal(aAfter - aBefore, applied - credited);

    // Before withdrawal, the loan contract holds exactly the failed share and
    // nothing more: lenderA's share was already pushed out.
    assert.equal(await publicClient.getBalance({ address: loanAddress }), credited);

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
      receipt.gasUsed < 450_000n,
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

  // --- Liquidation split + participation gates ---------------------------
  //
  // liquidate() runs the same _distribute() as repay(), so the pro-rata and
  // dust rules are identical. These tests read the actual seized amount from
  // the LoanLiquidated event emitted by the liquidate() transaction, never
  // from a pre-transaction liquidationPreview() - see the timing note above.

  it("splits a liquidation seizure pro-rata across two lenders and refunds the borrower surplus", async function () {
    const { loan, loanAddress } = await deployRequestedLoan();
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.6") });
    await loan.write.contribute({ account: lenderB.account, value: parseEther("0.4") });

    await loan.write.fastForward([durationDays * DAY + GRACE_PERIOD + 60n], { account: lenderA.account });
    assert.equal(await loan.read.isLiquidatable(), true);

    const aBefore = await publicClient.getBalance({ address: lenderA.account.address });
    const bBefore = await publicClient.getBalance({ address: lenderB.account.address });
    const borrowerBefore = await publicClient.getBalance({ address: borrower.account.address });

    // B, not A (the first contributor), triggers: proves any contributor can liquidate.
    const hash = await loan.write.liquidate({ account: lenderB.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;

    const { seizedAmount, refundedToBorrower } = await getLiquidatedEvent(loanAddress, loan.abi, receipt.blockNumber);

    const aAfter = await publicClient.getBalance({ address: lenderA.account.address });
    const bAfter = await publicClient.getBalance({ address: lenderB.account.address });
    const borrowerAfter = await publicClient.getBalance({ address: borrower.account.address });

    // A holds 60% and is not last in _lenders, so A's share is an exact
    // floor of the ACTUAL seized amount; B is last and absorbs the dust.
    const aShare = (seizedAmount * parseEther("0.6")) / parseEther("1");
    assert.equal(aAfter - aBefore, aShare);
    assert.equal(bAfter - bBefore + gas, seizedAmount - aShare);
    // No wei created or destroyed: A + B's shares sum exactly to the seizure.
    assert.equal((aAfter - aBefore) + (bAfter - bBefore + gas), seizedAmount);

    // Borrower's surplus refund is routed by the vault directly, not through
    // _distribute; it must equal the event's figure exactly, and seizure plus
    // refund must exactly reconstruct the original collateral.
    assert.equal(borrowerAfter - borrowerBefore, refundedToBorrower);
    assert.equal(seizedAmount + refundedToBorrower, collateralAmount);
    assert.equal(await loan.read.status(), 4); // Liquidated
  });

  it("three lenders: liquidation seizure splits exactly, with real interest dust", async function () {
    const { loan, loanAddress } = await deployRequestedLoan();
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.5") });
    await loan.write.contribute({ account: lenderB.account, value: parseEther("0.3") });
    await loan.write.contribute({ account: lenderC.account, value: parseEther("0.2") });

    await loan.write.fastForward([durationDays * DAY + GRACE_PERIOD + 60n], { account: lenderA.account });
    assert.equal(await loan.read.isLiquidatable(), true);

    const aBefore = await publicClient.getBalance({ address: lenderA.account.address });
    const bBefore = await publicClient.getBalance({ address: lenderB.account.address });
    const cBefore = await publicClient.getBalance({ address: lenderC.account.address });

    const hash = await loan.write.liquidate({ account: lenderC.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;

    const { seizedAmount } = await getLiquidatedEvent(loanAddress, loan.abi, receipt.blockNumber);

    const aAfter = await publicClient.getBalance({ address: lenderA.account.address });
    const bAfter = await publicClient.getBalance({ address: lenderB.account.address });
    const cAfter = await publicClient.getBalance({ address: lenderC.account.address });

    // A holds 50%, B 30%; both are non-last and get an exact floor share of
    // the ACTUAL seized amount. C is last, so C absorbs the dust.
    const aShare = (seizedAmount * parseEther("0.5")) / parseEther("1");
    const bShare = (seizedAmount * parseEther("0.3")) / parseEther("1");
    const cShare = seizedAmount - aShare - bShare;

    assert.equal(aAfter - aBefore, aShare);
    assert.equal(bAfter - bBefore, bShare);
    assert.equal(cAfter - cBefore + gas, cShare);
    assert.equal((aAfter - aBefore) + (bAfter - bBefore) + (cAfter - cBefore + gas), seizedAmount);

    // Confirm this seizure really does produce dust: the naive floor for C's
    // own 20% share differs from what C actually received.
    const naiveCShare = (seizedAmount * parseEther("0.2")) / parseEther("1");
    assert.notEqual(cShare, naiveCShare);
    assert.equal(await loan.read.status(), 4); // Liquidated
  });

  it("a non-contributor cannot liquidate", async function () {
    const { loan } = await deployRequestedLoan();
    await loan.write.contribute({ account: lenderA.account, value: parseEther("1") });
    await loan.write.fastForward([durationDays * DAY + GRACE_PERIOD + 60n], { account: lenderA.account });
    await viem.assertions.revertWith(
      loan.write.liquidate({ account: lenderB.account }),
      "Loan: caller is not a lender",
    );
  });

  it("rejects plain ETH transfers from anyone but the vault", async function () {
    const { loanAddress } = await deployRequestedLoan();
    await assert.rejects(
      lenderA.sendTransaction({ to: loanAddress, value: parseEther("0.1") }),
    );
  });

  it("once Funded, any contributor may fastForward but a stranger may not", async function () {
    // The gate is status-dependent (see commit ae3a445): borrower-only while
    // Requested, borrower-or-contributor once Funded. This covers the Funded
    // branch; MultiLenderFunding.ts covers the Requested branch.
    const { loan } = await deployRequestedLoan();
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.6") });
    await loan.write.contribute({ account: lenderB.account, value: parseEther("0.4") });
    assert.equal(await loan.read.status(), 1); // Funded

    // deployer contributed nothing to this loan
    await viem.assertions.revertWith(
      loan.write.fastForward([DAY], { account: deployer.account }),
      "Loan: not a participant",
    );
    await loan.write.fastForward([DAY], { account: lenderA.account }); // contributor: must not revert
    await loan.write.fastForward([DAY], { account: borrower.account }); // borrower: must not revert
  });

  it("a liquidation with a reverting contract lender still completes, crediting its share for withdrawal", async function () {
    const { loan, loanAddress } = await deployRequestedLoan();
    const rejecting = await viem.deployContract("RejectingReceiver", [], {
      client: { wallet: deployer, public: publicClient },
    });
    // rejecting contributes first, so it is _lenders[0], NOT the last lender:
    // its share is an exact floor, with no dust, independently computable.
    await rejecting.write.contributeTo([loanAddress], { account: deployer.account, value: parseEther("0.4") });
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.6") });

    await loan.write.fastForward([durationDays * DAY + GRACE_PERIOD + 60n], { account: lenderA.account });
    assert.equal(await loan.read.isLiquidatable(), true);

    const aBefore = await publicClient.getBalance({ address: lenderA.account.address });

    // accept stays false: the push to rejecting reverts, so its share must be
    // credited. lenderA triggers, proving the reverting co-lender cannot
    // block the seizure.
    const hash = await loan.write.liquidate({ account: lenderA.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;

    assert.equal(await loan.read.status(), 4); // liquidation was NOT blocked

    const { seizedAmount } = await getLiquidatedEvent(loanAddress, loan.abi, receipt.blockNumber);

    // Independently compute the expected share instead of trusting the
    // contract's own recorded value: floor rejecting's known 0.4 ETH
    // contribution out of the 1 ETH principal against the actual seizure.
    const expectedShare = (seizedAmount * parseEther("0.4")) / parseEther("1");

    const credited = await loan.read.pendingWithdrawals([rejecting.address]);
    assert.ok(credited > 0n, "failed push must be credited for withdrawal");
    assert.equal(credited, expectedShare, "credited amount must equal the independently computed exact floor");

    // The well-behaved EOA co-lender (lenderA, last in the array, and the one
    // who triggered liquidation) must still be paid its full share by push in
    // the same transaction, despite rejecting's push failing.
    const aAfter = await publicClient.getBalance({ address: lenderA.account.address });
    assert.equal(aAfter - aBefore + gas, seizedAmount - credited);

    // Before withdrawal, the loan contract holds exactly the failed share.
    assert.equal(await publicClient.getBalance({ address: loanAddress }), credited);

    // Arm the receiver, withdraw, and verify the credit pays out in full.
    await rejecting.write.setAccept([true], { account: deployer.account });
    const rBefore = await publicClient.getBalance({ address: rejecting.address });
    await rejecting.write.withdrawFrom([loanAddress], { account: deployer.account });
    const rAfter = await publicClient.getBalance({ address: rejecting.address });
    assert.equal(rAfter - rBefore, credited);
    assert.equal(await loan.read.pendingWithdrawals([rejecting.address]), 0n);
  });
});
