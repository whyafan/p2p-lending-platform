import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const INITIAL_PRICE = 2_000n; // $2,000/ETH

// Reads one field of a returned struct by position or by name. viem hands back a
// tuple or a named object depending on whether the compiled ABI kept the component
// names, so both shapes have to be accepted for the same read to work either way.
function getStructValue<T>(record: unknown, index: number, key: string): T {
  const value = Array.isArray(record)
    ? record[index]
    : (record as Record<string, unknown>)[key];

  return value as T;
}

// Covers creation and funding only. Everything after funding lives in
// LoanLifecycle.ts.
describe("NexusFi Milestone 1", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, borrower, lender] = await viem.getWalletClients();

  async function deployMilestoneContracts() {
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

    return { collateralVault, loanFactory };
  }

  it("creates a loan request and locks borrower collateral", async function () {
    const { collateralVault, loanFactory } = await deployMilestoneContracts();

    // Principal is larger than the collateral: createLoan checks only the structural
    // bounds, never principal against collateral value, so this is a valid request as
    // far as the factory is concerned. Sizing is the client's job, via loan-terms.ts.
    const principalAmount = parseEther("5");
    const collateralAmount = parseEther("2");
    const durationDays = 30n;
    const interestBps = 500n;
    const maxLtvBps = 7_000n;
    const liquidationBufferBps = 1_000n;

    await viem.assertions.emit(
      loanFactory.write.createLoan(
        [
          principalAmount,
          durationDays,
          interestBps,
          maxLtvBps,
          liquidationBufferBps,
        ],
        {
          account: borrower.account,
          value: collateralAmount,
        },
      ),
      loanFactory,
      "LoanCreated",
    );

    const loanCount = await loanFactory.read.getLoanCount();
    const loanTerms = await loanFactory.read.loans([0n]);
    const collateralPosition = await collateralVault.read.positions([0n]);

    assert.equal(loanCount, 1n);
    assert.equal(
      getAddress(getStructValue(loanTerms, 1, "borrower")),
      getAddress(borrower.account.address),
    );
    assert.equal(getStructValue(loanTerms, 2, "principalAmount"), principalAmount);
    assert.equal(getStructValue(loanTerms, 3, "collateralAmount"), collateralAmount);
    assert.equal(
      getAddress(getStructValue(collateralPosition, 0, "borrower")),
      getAddress(borrower.account.address),
    );
    assert.equal(getStructValue(collateralPosition, 2, "amount"), collateralAmount);
    assert.equal(getStructValue(collateralPosition, 3, "released"), false);
    assert.equal(getStructValue(collateralPosition, 4, "liquidated"), false);
  });

  it("lets a lender fund a requested loan and pays principal to the borrower", async function () {
    const { loanFactory } = await deployMilestoneContracts();

    const principalAmount = parseEther("5");

    await loanFactory.write.createLoan(
      [principalAmount, 30n, 500n, 7_000n, 1_000n],
      {
        account: borrower.account,
        value: parseEther("2"),
      },
    );

    const loanTerms = await loanFactory.read.loans([0n]);
    const loanAddress = getStructValue<`0x${string}`>(loanTerms, 0, "loanContract");
    const loan = await viem.getContractAt("Loan", loanAddress, {
      client: { wallet: lender, public: publicClient },
    });

    const borrowerBalanceBefore = await publicClient.getBalance({
      address: borrower.account.address,
    });

    await viem.assertions.emitWithArgs(
      loan.write.fund({ account: lender.account, value: principalAmount }),
      loan,
      "LoanFunded",
      [0n, getAddress(lender.account.address), principalAmount],
    );

    const borrowerBalanceAfter = await publicClient.getBalance({
      address: borrower.account.address,
    });

    assert.equal(await loan.read.status(), 1);
    assert.equal((await loan.read.lender()).toLowerCase(), lender.account.address.toLowerCase());
    assert.equal(borrowerBalanceAfter - borrowerBalanceBefore, principalAmount);
  });
});
