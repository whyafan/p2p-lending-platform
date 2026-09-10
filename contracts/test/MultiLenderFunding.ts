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

const DAY = 86_400n;
const INITIAL_PRICE = 2_000n;

describe("Multi-lender funding phase", async function () {
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

  it("accumulates contributions and stays Requested until full", async function () {
    const { loan } = await deployRequestedLoan();

    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.4") });
    assert.equal(await loan.read.status(), 0); // Requested
    assert.equal(await loan.read.totalContributed(), parseEther("0.4"));
    assert.equal(await loan.read.contributions([lenderA.account.address]), parseEther("0.4"));
    assert.equal(await loan.read.fundingProgressBps(), 4_000n);

    await loan.write.contribute({ account: lenderB.account, value: parseEther("0.35") });
    assert.equal(await loan.read.status(), 0);
    assert.equal(await loan.read.totalContributed(), parseEther("0.75"));
    const lenders = await loan.read.getLenders();
    assert.equal(lenders.length, 2);
  });

  it("funds the loan and pays the borrower when contributions reach the principal", async function () {
    const { loan } = await deployRequestedLoan();
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.6") });

    const borrowerBefore = await publicClient.getBalance({ address: borrower.account.address });
    await viem.assertions.emit(
      loan.write.contribute({ account: lenderB.account, value: parseEther("0.4") }),
      loan,
      "LoanFunded",
    );
    const borrowerAfter = await publicClient.getBalance({ address: borrower.account.address });

    assert.equal(await loan.read.status(), 1); // Funded
    assert.equal(borrowerAfter - borrowerBefore, principalAmount);
    assert.equal(await loan.read.priceAtFunding(), INITIAL_PRICE);
    assert.ok((await loan.read.fundedAt()) > 0n);
  });

  it("refunds the excess on an over-filling final contribution", async function () {
    const { loan, loanAddress } = await deployRequestedLoan();
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.7") });

    const sent = parseEther("0.5"); // only 0.3 remains
    const bBefore = await publicClient.getBalance({ address: lenderB.account.address });
    const hash = await loan.write.contribute({ account: lenderB.account, value: sent });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    const bAfter = await publicClient.getBalance({ address: lenderB.account.address });

    assert.equal(bBefore - bAfter, parseEther("0.3") + gas); // paid 0.3 net, excess returned
    assert.equal(await loan.read.contributions([lenderB.account.address]), parseEther("0.3"));
    assert.equal(await loan.read.status(), 1);
    // Escrow is fully drained on funding: no stray ETH left on the loan.
    assert.equal(await publicClient.getBalance({ address: loanAddress }), 0n);
  });

  it("one lender contributing the full principal reproduces single-lender behavior", async function () {
    const { loan } = await deployRequestedLoan();
    await viem.assertions.emit(
      loan.write.contribute({ account: lenderA.account, value: principalAmount }),
      loan,
      "LoanFunded",
    );
    assert.equal(await loan.read.status(), 1);
    const lenders = await loan.read.getLenders();
    assert.equal(lenders.length, 1);
    assert.equal(await loan.read.contributions([lenderA.account.address]), principalAmount);
  });

  it("enforces the 1% minimum per call, top-ups included", async function () {
    const { loan } = await deployRequestedLoan();
    const min = await loan.read.minContribution();
    assert.equal(min, principalAmount / 100n);

    await viem.assertions.revertWith(
      loan.write.contribute({ account: lenderA.account, value: min - 1n }),
      "Loan: below minimum contribution",
    );
    await loan.write.contribute({ account: lenderA.account, value: min });
    await viem.assertions.revertWith(
      loan.write.contribute({ account: lenderA.account, value: min - 1n }),
      "Loan: below minimum contribution",
    );
  });

  it("a top-up does not consume a new lender slot", async function () {
    const { loan } = await deployRequestedLoan();
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.1") });
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.1") });
    const lenders = await loan.read.getLenders();
    assert.equal(lenders.length, 1);
    assert.equal(await loan.read.contributions([lenderA.account.address]), parseEther("0.2"));
  });

  it("rejects the borrower contributing and contributions once expired", async function () {
    const { loan } = await deployRequestedLoan();
    await viem.assertions.revertWith(
      loan.write.contribute({ account: borrower.account, value: parseEther("0.5") }),
      "Loan: borrower cannot fund",
    );
    await loan.write.fastForward([8n * DAY], { account: borrower.account }); // window is 7 days
    await viem.assertions.revertWith(
      loan.write.contribute({ account: lenderA.account, value: parseEther("0.5") }),
      "Loan: funding window has expired",
    );
  });

  it("lets contributors reclaim after cancel, exactly once", async function () {
    const { loan } = await deployRequestedLoan();
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.4") });
    await loan.write.contribute({ account: lenderB.account, value: parseEther("0.2") });

    await loan.write.cancel({ account: borrower.account });
    assert.equal(await loan.read.status(), 3); // Cancelled

    const aBefore = await publicClient.getBalance({ address: lenderA.account.address });
    const hash = await loan.write.reclaimContribution({ account: lenderA.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    const aAfter = await publicClient.getBalance({ address: lenderA.account.address });

    assert.equal(aAfter - aBefore, parseEther("0.4") - gas);
    assert.equal(await loan.read.contributions([lenderA.account.address]), 0n);
    await viem.assertions.revertWith(
      loan.write.reclaimContribution({ account: lenderA.account }),
      "Loan: no contribution",
    );
    // The other contributor's escrow is untouched until they reclaim it themselves.
    assert.equal(await loan.read.contributions([lenderB.account.address]), parseEther("0.2"));
  });

  it("lets contributors reclaim from an expired, partially filled loan", async function () {
    const { loan } = await deployRequestedLoan();
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.4") });
    await loan.write.fastForward([8n * DAY], { account: borrower.account }); // only the borrower may expire a Requested loan

    await viem.assertions.emit(
      loan.write.reclaimContribution({ account: lenderA.account }),
      loan,
      "ContributionReclaimed",
    );
    assert.equal(await loan.read.totalContributed(), 0n);
  });

  it("rejects a contributor fastForwarding a Requested loan, but allows the borrower", async function () {
    const { loan } = await deployRequestedLoan();
    const min = await loan.read.minContribution();
    await loan.write.contribute({ account: lenderA.account, value: min });

    await viem.assertions.revertWith(
      loan.write.fastForward([8n * DAY], { account: lenderA.account }),
      "Loan: not a participant",
    );

    await loan.write.fastForward([8n * DAY], { account: borrower.account }); // window is 7 days
    await viem.assertions.revertWith(
      loan.write.contribute({ account: lenderB.account, value: min }),
      "Loan: funding window has expired",
    );
  });

  it("reverts reclaim while the loan is still fundable", async function () {
    const { loan } = await deployRequestedLoan();
    await loan.write.contribute({ account: lenderA.account, value: parseEther("0.4") });
    await viem.assertions.revertWith(
      loan.write.reclaimContribution({ account: lenderA.account }),
      "Loan: nothing to reclaim",
    );
  });

  it("enforces MAX_LENDERS distinct contributors", async function () {
    const { loan } = await deployRequestedLoan();
    assert.equal(await loan.read.MAX_LENDERS(), 10n);

    // Hardhat's default account set has 20 wallets; excluding the borrower
    // that is at least 19 usable wallets, well over the 11 needed to actually
    // hit the cap (10 succeed, the 11th distinct contributor reverts).
    const allWallets = await viem.getWalletClients();
    const nonBorrowerWallets = allWallets.filter(
      (w) => w.account.address.toLowerCase() !== borrower.account.address.toLowerCase(),
    );
    assert.ok(
      nonBorrowerWallets.length >= 11,
      "expected at least 11 non-borrower wallets from the default Hardhat account set",
    );

    const min = await loan.read.minContribution();
    for (let i = 0; i < 10; i++) {
      await loan.write.contribute({ account: nonBorrowerWallets[i].account, value: min });
    }
    const lenders = await loan.read.getLenders();
    assert.equal(lenders.length, 10);

    await viem.assertions.revertWith(
      loan.write.contribute({ account: nonBorrowerWallets[10].account, value: min }),
      "Loan: lender cap reached",
    );
  });
});
