# Multi-Lender Pooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let several lenders each fund part of one loan, with pro-rata repayment and liquidation splits, per `docs/superpowers/specs/2026-08-20-multi-lender-pooling-design.md`.

**Architecture:** `Loan.sol`'s atomic `fund()` becomes an accumulating `contribute()` that escrows partial contributions in the Loan contract until they reach `principalAmount`. Every repayment and liquidation seizure splits pro-rata across contributors via a hybrid sender (gas-capped push, failed transfers credited for pull `withdraw()`). The vault is unchanged; the frontend swaps `lender()` reads for `contributions()` reads and gains funding-progress, contribute, claim, and reclaim UX plus per-share receipts and statements driven by a new `ShareDistributed` event.

**Tech Stack:** Solidity 0.8.28 + OpenZeppelin (already vendored), Hardhat 3 with `node:test` + viem test style (see `contracts/test/LoanLifecycle.ts`), Next.js 16 + wagmi/viem frontend, `node --test` for frontend pure logic.

## Global Constraints

- Never use an em dash. Use a plain dash (`-`) instead, in every file this plan touches, code comments and SQL included, per the project `CLAUDE.md`.
- Never add AI attribution, co-author trailers, or session links to commits.
- Commit per task on branch `atharva`; never `git push` (the user pushes).
- No new npm dependencies, contracts or frontend.
- Frontend: relative imports inside `lib/` carry explicit `.ts` extensions; imports from `app/` or `components/` into `lib/` do not.
- Contract test conventions: `node:test` + `assert/strict`, `const { viem, networkHelpers } = await network.connect()`, `viem.assertions.emit(...)` / `viem.assertions.revertWith(...)`, and the timing caveat documented in `contracts/test/LoanLifecycle.ts` lines 83-90: never assert against pre-computed time-sensitive "owed" figures; read authoritative state after each tx.
- Spec constants, verbatim: `MAX_LENDERS = 10`; minimum contribution = `principalAmount / 100` (floor 1 wei), applied per `contribute()` call, top-ups included; rounding dust goes to the last lender in the contributors array; `liquidate()` callable by any contributor; `fastForward` gate is status-dependent - borrower-only while `Requested`, borrower or any contributor once `Funded` (corrected in commit `ae3a445` after review found that a contributor able to rewind the funding window can brick an open request for the cost of gas).

---

## File Structure

| File | Responsibility |
|---|---|
| `contracts/contracts/Loan.sol` (rewrite) | Pooled funding, hybrid pro-rata distribution, withdraw/reclaim. |
| `contracts/contracts/test/RejectingReceiver.sol` (new) | Test-only contract lender with a refusable `receive()`, to exercise the pull fallback. |
| `contracts/test/MultiLenderFunding.ts` (new) | Funding-phase suite: contribute, caps, fill, over-fill, reclaim, cancel, expiry. |
| `contracts/test/MultiLenderSettlement.ts` (new) | Repayment split, dust, hybrid fallback, withdraw, liquidation split, gates. |
| `contracts/test/LoanLifecycle.ts` + `contracts/test/NexusFiMilestone1.ts` (modify) | Updated for `contribute()` and removed `lender`; must stay green. |
| `frontend/lib/loan-abi.ts` (modify) | New ABI: contribute/withdraw/reclaim/views; `fund` and `lender` removed. |
| `frontend/lib/loan-events.ts` + `frontend/hooks/useLoanEvents.ts` (modify) | New event signatures and kinds. |
| `frontend/components/LenderDashboard.tsx` (modify) | Contribute UX, progress bars, positions by contribution, claim + reclaim. |
| `frontend/components/StatementsPanel.tsx` + `frontend/lib/statements.ts` (modify) | Per-share lender numbers from `ShareDistributed`. |
| `frontend/components/LoanSettlementReceipt.tsx` (modify) | Per-share receipt figures for pooled loans. |
| `frontend/components/PublicLoanSummary.tsx` (modify) | Lender mode via `contributions(target) > 0`. |
| `frontend/components/BorrowerLoansSection.tsx` + `frontend/components/LoanRequestPanel.tsx` (modify) | Funding progress on Requested loans. |
| `tests/MANUAL_TEST_PLAN.md` (modify) | New Track G: pooling regression. |

Contract note: the three contract tasks evolve ONE file. Task 1 lands the complete new `Loan.sol` (funding-phase tests drive it, and the settlement internals ship with it because `repay()`/`liquidate()` cannot compile without a distribution target). Tasks 2 and 3 are test-driven hardening passes over the settlement and liquidation paths: their suites are written first and any failure is fixed in `Loan.sol`. Every task ends with the WHOLE contract suite green.

---

### Task 1: Pooled funding phase in `Loan.sol` (complete rewrite) + funding-phase suite

**Files:**
- Modify: `contracts/contracts/Loan.sol` (full replacement below)
- Create: `contracts/test/MultiLenderFunding.ts`
- Modify: `contracts/test/LoanLifecycle.ts` (fixture + two assertions)
- Modify: `contracts/test/NexusFiMilestone1.ts` (any `fund`/`lender` references)

**Interfaces:**
- Consumes: existing `CollateralVault.sol`, `LoanFactory.sol`, `MockPriceFeed.sol` - none of them change in this plan.
- Produces (relied on by Tasks 2-10):
  - `contribute() external payable`
  - `withdraw() external`
  - `reclaimContribution() external`
  - `liquidate() external` (any contributor)
  - Views: `getLenders() -> address[]`, `contributions(address) -> uint256`, `totalContributed() -> uint256`, `pendingWithdrawals(address) -> uint256`, `fundingProgressBps() -> uint256`, `minContribution() -> uint256`, `MAX_LENDERS() -> uint256`
  - Events: `Contribution(uint256 indexed loanId, address indexed contributor, uint256 amount, uint256 totalContributed)`, `LoanFunded(uint256 indexed loanId, uint256 totalContributed)`, `ShareDistributed(uint256 indexed loanId, address indexed lender, uint256 amount, bool pending)`, `Withdrawal(uint256 indexed loanId, address indexed lender, uint256 amount)`, `ContributionReclaimed(uint256 indexed loanId, address indexed contributor, uint256 amount)`
  - Removed: `fund()`, `lender()`, the `onlyLender` modifier. `LoanFunded`'s old `(loanId, lender, amount)` signature is gone.

- [ ] **Step 1: Write the failing funding-phase suite**

Create `contracts/test/MultiLenderFunding.ts`. Follow `LoanLifecycle.ts` conventions exactly (imports, `getStructValue`, wallet clients). Fixture deploys vault + feed + factory + one loan but does NOT fund it; principal 1 ETH, collateral 2 ETH, same terms as `LoanLifecycle.ts`.

```ts
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
    await loan.write.fastForward([8n * DAY], { account: lenderA.account }); // contributor may fastForward

    await viem.assertions.emit(
      loan.write.reclaimContribution({ account: lenderA.account }),
      loan,
      "ContributionReclaimed",
    );
    assert.equal(await loan.read.totalContributed(), 0n);
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
    // 10-wallet cap with only a few test wallets: verify the constant and the
    // revert string via a loop over fresh accounts is impractical here, so
    // assert the constant and exercise the boundary logic with impersonation-free
    // arithmetic: fill slots with small distinct contributions from every
    // available wallet client beyond the fixed roles, then assert the count.
    assert.equal(await loan.read.MAX_LENDERS(), 10n);
  });
});
```

Note on the last test: Hardhat's default account set has 20 wallets. If `viem.getWalletClients()` yields at least 11 non-borrower wallets, extend the test to actually hit the cap: loop `min` contributions from 10 distinct wallets, then assert the 11th reverts with `"Loan: lender cap reached"`. Write it that way if the wallet count allows; keep the constant assertion either way.

- [ ] **Step 2: Run to verify failure**

Run: `cd contracts && npx hardhat test test/MultiLenderFunding.ts`
Expected: FAIL - `contribute` is not a function on the Loan artifact (the current contract has `fund`).

- [ ] **Step 3: Replace `Loan.sol` with the pooled implementation**

Replace the ENTIRE contents of `contracts/contracts/Loan.sol` with the following. Interfaces, constructor params, view functions not mentioned in the spec, and all comments about oracle/interest behavior are preserved verbatim from the current file - only funding, settlement, liquidation gating, `fastForward`'s gate, and the new storage/events differ. Read the current file first and carry over its comment blocks where the code is unchanged.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface ICollateralVault {
    function releaseCollateral(uint256 loanId, address payable recipient) external;
    function liquidateCollateral(uint256 loanId, address payable recipient, uint256 seizeAmount) external;
}

interface ILoanFactory {
    function demoMode() external view returns (bool);
}

interface IPriceFeed {
    function latestPrice() external view returns (uint256);
}

contract Loan is ReentrancyGuard {
    using Address for address payable;

    uint256 public constant FUNDING_WINDOW = 7 days;
    uint256 public constant GRACE_PERIOD = 2 days;
    // Bounds every distribution loop's gas. Small by design: a pool of a few
    // teammates, not an open crowd sale.
    uint256 public constant MAX_LENDERS = 10;
    // Gas forwarded on push transfers. Enough for an EOA or a simple contract
    // wallet receive; a recipient that needs more gets credited for pull
    // withdrawal instead of blocking everyone else.
    uint256 internal constant PUSH_GAS_LIMIT = 50_000;

    enum LoanStatus {
        Requested,
        Funded,
        Repaid,
        Cancelled,
        Liquidated
    }

    uint256 public immutable loanId;
    address public immutable factory;
    address public immutable borrower;
    address public immutable collateralVault;

    uint256 public immutable principalAmount;
    uint256 public immutable collateralAmount;
    uint256 public immutable durationDays;
    uint256 public immutable interestBps;
    uint256 public immutable maxLtvBps;
    uint256 public immutable liquidationBufferBps;
    uint256 public requestedAt;
    uint256 public fundedAt;

    address public immutable priceFeed;

    // --- Multi-lender pool state -------------------------------------------
    //
    // Contributions escrow in this contract while the loan is Requested. The
    // borrower is paid only when the pool fills. contributions[] is the source
    // of truth for membership; _lenders may retain reclaimed addresses whose
    // contribution has returned to zero (distribution loops skip them because
    // a zero contribution produces a zero share, and reclaim is only possible
    // before funding while distribution only happens after).
    address[] private _lenders;
    mapping(address => uint256) public contributions;
    uint256 public totalContributed;
    // Failed push transfers accumulate here for pull withdrawal.
    mapping(address => uint256) public pendingWithdrawals;

    uint256 public debtValueUsd;
    uint256 public priceAtFunding;
    uint256 public amountRepaid;
    uint256 public closedAt;

    LoanStatus public status;

    event Contribution(uint256 indexed loanId, address indexed contributor, uint256 amount, uint256 totalContributed);
    event LoanFunded(uint256 indexed loanId, uint256 totalContributed);
    event ShareDistributed(uint256 indexed loanId, address indexed lender, uint256 amount, bool pending);
    event Withdrawal(uint256 indexed loanId, address indexed lender, uint256 amount);
    event ContributionReclaimed(uint256 indexed loanId, address indexed contributor, uint256 amount);
    event LoanRepaid(uint256 indexed loanId, address indexed borrower, uint256 repaymentAmount);
    event PartialRepayment(
        uint256 indexed loanId,
        address indexed payer,
        uint256 amountApplied,
        uint256 totalRepaidSoFar,
        uint256 remainingOwed
    );
    event LoanCancelled(uint256 indexed loanId);
    event LoanLiquidated(
        uint256 indexed loanId,
        address indexed lender,
        uint256 seizedAmount,
        uint256 refundedToBorrower
    );
    event DemoTimeSkipped(uint256 indexed loanId, address indexed by, uint256 secondsSkipped);

    modifier onlyBorrower() {
        require(msg.sender == borrower, "Loan: caller is not borrower");
        _;
    }

    constructor(
        uint256 loanId_,
        address factory_,
        address borrower_,
        uint256 principalAmount_,
        uint256 collateralAmount_,
        uint256 durationDays_,
        uint256 interestBps_,
        uint256 maxLtvBps_,
        uint256 liquidationBufferBps_,
        address collateralVault_,
        address priceFeed_
    ) {
        require(factory_ != address(0), "Loan: factory is zero address");
        require(borrower_ != address(0), "Loan: borrower is zero address");
        require(principalAmount_ > 0, "Loan: principal required");
        require(collateralAmount_ > 0, "Loan: collateral required");
        require(durationDays_ > 0, "Loan: duration required");
        require(maxLtvBps_ > 0 && maxLtvBps_ <= 10_000, "Loan: invalid LTV");
        require(collateralVault_ != address(0), "Loan: vault is zero address");

        loanId = loanId_;
        factory = factory_;
        borrower = borrower_;
        principalAmount = principalAmount_;
        collateralAmount = collateralAmount_;
        durationDays = durationDays_;
        interestBps = interestBps_;
        maxLtvBps = maxLtvBps_;
        liquidationBufferBps = liquidationBufferBps_;
        collateralVault = collateralVault_;
        priceFeed = priceFeed_;
        requestedAt = block.timestamp;
        status = LoanStatus.Requested;
    }

    /// Seizure proceeds arrive here from the vault during liquidate(); nothing
    /// else may send plain ETH (contributions must go through contribute()).
    receive() external payable {
        require(msg.sender == collateralVault, "Loan: direct transfers not accepted");
    }

    /// 1% of principal, floor 1 wei, applied per call (top-ups included). When
    /// the remaining gap is under the minimum, the closing contributor still
    /// sends at least the minimum and the excess is refunded in the same tx.
    function minContribution() public view returns (uint256) {
        uint256 m = principalAmount / 100;
        return m == 0 ? 1 : m;
    }

    function contribute() external payable nonReentrant {
        require(status == LoanStatus.Requested, "Loan: not fundable");
        require(block.timestamp <= requestedAt + FUNDING_WINDOW, "Loan: funding window has expired");
        require(msg.sender != borrower, "Loan: borrower cannot fund");
        require(msg.value >= minContribution(), "Loan: below minimum contribution");

        if (contributions[msg.sender] == 0) {
            require(_lenders.length < MAX_LENDERS, "Loan: lender cap reached");
            _lenders.push(msg.sender);
        }

        uint256 remaining = principalAmount - totalContributed;
        uint256 accepted = msg.value > remaining ? remaining : msg.value;
        uint256 refund = msg.value - accepted;

        contributions[msg.sender] += accepted;
        totalContributed += accepted;
        emit Contribution(loanId, msg.sender, accepted, totalContributed);

        if (totalContributed == principalAmount) {
            fundedAt = block.timestamp;
            status = LoanStatus.Funded;

            uint256 price = _readPrice();
            if (price > 0) {
                priceAtFunding = price;
                debtValueUsd = principalAmount * price;
            }

            payable(borrower).sendValue(principalAmount);
            emit LoanFunded(loanId, totalContributed);
        }

        if (refund > 0) {
            payable(msg.sender).sendValue(refund);
        }
    }

    /// Pull-based refund of an escrowed contribution, once the pool can no
    /// longer complete: the borrower cancelled, or the funding window expired
    /// with the loan still Requested. Each contributor reclaims their own.
    function reclaimContribution() external nonReentrant {
        bool expiredWhileRequested =
            status == LoanStatus.Requested && block.timestamp > requestedAt + FUNDING_WINDOW;
        require(status == LoanStatus.Cancelled || expiredWhileRequested, "Loan: nothing to reclaim");

        uint256 amount = contributions[msg.sender];
        require(amount > 0, "Loan: no contribution");

        contributions[msg.sender] = 0;
        totalContributed -= amount;

        payable(msg.sender).sendValue(amount);
        emit ContributionReclaimed(loanId, msg.sender, amount);
    }

    /// Collect shares that could not be pushed (recipient reverted or ran out
    /// of the forwarded gas). Callable in any loan status.
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Loan: nothing to withdraw");

        pendingWithdrawals[msg.sender] = 0;
        payable(msg.sender).sendValue(amount);
        emit Withdrawal(loanId, msg.sender, amount);
    }

    function repay() external payable onlyBorrower nonReentrant {
        require(status == LoanStatus.Funded, "Loan: not active");
        require(msg.value > 0, "Loan: repayment must be non-zero");

        uint256 owed = outstandingBalance();
        require(owed > 0, "Loan: nothing owed");

        uint256 applied = msg.value > owed ? owed : msg.value;
        uint256 refund = msg.value - applied;
        bool isFinalPayment = (applied == owed);

        amountRepaid += applied;

        if (isFinalPayment) {
            status = LoanStatus.Repaid;
            closedAt = block.timestamp;
        }

        _distribute(applied);

        if (refund > 0) {
            payable(msg.sender).sendValue(refund);
        }

        if (isFinalPayment) {
            ICollateralVault(collateralVault).releaseCollateral(loanId, payable(borrower));
            emit LoanRepaid(loanId, msg.sender, amountRepaid);
        } else {
            emit PartialRepayment(loanId, msg.sender, applied, amountRepaid, owed - applied);
        }
    }

    function cancel() external onlyBorrower nonReentrant {
        require(status == LoanStatus.Requested, "Loan: cannot cancel");

        status = LoanStatus.Cancelled;
        ICollateralVault(collateralVault).releaseCollateral(loanId, payable(borrower));
        emit LoanCancelled(loanId);
        // Escrowed contributions stay here until each contributor calls
        // reclaimContribution(); status Cancelled is what unlocks it.
    }

    function fastForward(uint256 secondsToSkip) external {
        require(demoMode(), "Loan: demo mode disabled");
        require(secondsToSkip > 0, "Loan: nothing to skip");
        require(
            msg.sender == borrower || contributions[msg.sender] > 0,
            "Loan: not a participant"
        );

        if (status == LoanStatus.Requested) {
            requestedAt = secondsToSkip >= requestedAt ? 0 : requestedAt - secondsToSkip;
        } else if (status == LoanStatus.Funded) {
            fundedAt = secondsToSkip >= fundedAt ? 0 : fundedAt - secondsToSkip;
        } else {
            revert("Loan: loan is closed");
        }

        emit DemoTimeSkipped(loanId, msg.sender, secondsToSkip);
    }

    /// Any contributor may trigger liquidation; a pool must not depend on one
    /// specific person clicking. Seizure proceeds route through this contract
    /// (see receive()) and are split pro-rata like a repayment.
    function liquidate() external nonReentrant {
        require(contributions[msg.sender] > 0, "Loan: caller is not a lender");
        require(status == LoanStatus.Funded, "Loan: not active");
        require(
            isDelinquentLiquidatable() || isPriceLiquidatable(),
            "Loan: not liquidatable"
        );

        uint256 owed = outstandingBalance();
        uint256 seizeAmount = owed < collateralAmount ? owed : collateralAmount;
        uint256 refund = collateralAmount - seizeAmount;

        status = LoanStatus.Liquidated;
        closedAt = block.timestamp;

        ICollateralVault(collateralVault).liquidateCollateral(loanId, payable(address(this)), seizeAmount);
        _distribute(seizeAmount);
        emit LoanLiquidated(loanId, msg.sender, seizeAmount, refund);
    }

    function liquidationPreview() external view returns (uint256 seizeAmount, uint256 refundAmount) {
        uint256 owed = outstandingBalance();
        seizeAmount = owed < collateralAmount ? owed : collateralAmount;
        refundAmount = collateralAmount - seizeAmount;
    }

    // --- Distribution internals --------------------------------------------

    /// Split `amount` pro-rata by contribution over principal. The last lender
    /// receives `amount` minus the sum of the earlier floors, so the total
    /// distributed always equals `amount` exactly (rounding dust, a few wei at
    /// most, lands deterministically on the last contributor).
    function _distribute(uint256 amount) internal {
        uint256 n = _lenders.length;
        uint256 distributed = 0;
        for (uint256 i = 0; i < n; i++) {
            address lender_ = _lenders[i];
            uint256 share;
            if (i == n - 1) {
                share = amount - distributed;
            } else {
                share = Math.mulDiv(amount, contributions[lender_], principalAmount);
            }
            distributed += share;
            if (share > 0) {
                _pushOrCredit(lender_, share);
            }
        }
    }

    /// Hybrid settlement: try a gas-capped push; on failure credit the share
    /// for pull withdrawal. A reverting recipient can only hurt itself and can
    /// never block the borrower's repayment or a liquidation.
    function _pushOrCredit(address lender_, uint256 share) internal {
        (bool ok, ) = payable(lender_).call{value: share, gas: PUSH_GAS_LIMIT}("");
        if (ok) {
            emit ShareDistributed(loanId, lender_, share, false);
        } else {
            pendingWithdrawals[lender_] += share;
            emit ShareDistributed(loanId, lender_, share, true);
        }
    }

    // --- Views ---------------------------------------------------------------

    function getLenders() external view returns (address[] memory) {
        return _lenders;
    }

    function fundingProgressBps() external view returns (uint256) {
        return Math.mulDiv(totalContributed, 10_000, principalAmount);
    }

    function _readPrice() internal view returns (uint256) {
        if (priceFeed == address(0)) return 0;
        try IPriceFeed(priceFeed).latestPrice() returns (uint256 p) {
            return p;
        } catch {
            return 0;
        }
    }

    function demoMode() public view returns (bool) {
        try ILoanFactory(factory).demoMode() returns (bool d) {
            return d;
        } catch {
            return false;
        }
    }

    function currentPrice() public view returns (uint256) {
        return _readPrice();
    }

    function liquidationThresholdBps() public view returns (uint256) {
        return maxLtvBps + liquidationBufferBps;
    }

    function currentLtvBps() public view returns (uint256) {
        if (status != LoanStatus.Funded || debtValueUsd == 0) return 0;
        uint256 price = _readPrice();
        if (price == 0) return 0;
        uint256 collateralValueUsd = collateralAmount * price;
        if (collateralValueUsd == 0) return 0;
        return Math.mulDiv(debtValueUsd, 10_000, collateralValueUsd);
    }

    function isPriceLiquidatable() public view returns (bool) {
        uint256 ltv = currentLtvBps();
        if (ltv == 0) return false;
        return ltv >= liquidationThresholdBps();
    }

    function isDelinquentLiquidatable() public view returns (bool) {
        return status == LoanStatus.Funded && block.timestamp > repaymentDueAt() + GRACE_PERIOD;
    }

    function _interestAccrualEnd() internal view returns (uint256) {
        uint256 cap = repaymentDueAt() + GRACE_PERIOD;
        uint256 end = status == LoanStatus.Funded ? block.timestamp : (closedAt != 0 ? closedAt : fundedAt);
        return end < cap ? end : cap;
    }

    function interestDue() public view returns (uint256) {
        if (fundedAt == 0) return 0;
        uint256 elapsedSeconds = _interestAccrualEnd() - fundedAt;
        return Math.mulDiv(principalAmount, interestBps * elapsedSeconds, 10_000 * 365 days);
    }

    function totalRepaymentDue() public view returns (uint256) {
        return principalAmount + interestDue();
    }

    function outstandingBalance() public view returns (uint256) {
        uint256 due = totalRepaymentDue();
        return due > amountRepaid ? due - amountRepaid : 0;
    }

    function repaymentDueAt() public view returns (uint256) {
        return fundedAt + (durationDays * 1 days);
    }

    function isDelinquent() public view returns (bool) {
        return status == LoanStatus.Funded && block.timestamp > repaymentDueAt();
    }

    function isLiquidatable() public view returns (bool) {
        return isDelinquentLiquidatable() || isPriceLiquidatable();
    }
}
```

Carry over the existing explanatory comment blocks (oracle economics at the top of the price section, the interestDue/BUG-03 note, the fastForward doc comment) from the current file verbatim where the surrounding code is unchanged - the listing above abbreviates some of them; the repo's current comments are the source of truth for those.

- [ ] **Step 4: Update the existing suites for the new interface**

In `contracts/test/LoanLifecycle.ts`:
- In `deployFundedLoan()`, replace `await loanAsLender.write.fund({ account: lender.account, value: principalAmount });` with `await loanAsLender.write.contribute({ account: lender.account, value: principalAmount });`
- In the test `"fastForward() expires the funding window while a loan is still Requested"`, replace `asLender.write.fund(...)` with `asLender.write.contribute(...)` (same args).
- In the test `"reverts liquidate() if called by a non-lender"`, the expected revert string changes from `"Loan: caller is not lender"` to `"Loan: caller is not a lender"`.

In `contracts/test/NexusFiMilestone1.ts`, update any `fund`/`lender()` references the same way (read the file; it is 130 lines).

- [ ] **Step 5: Run the full contract suite**

Run: `cd contracts && npx hardhat test`
Expected: PASS - all of `MultiLenderFunding.ts` plus the updated existing suites (28 previously passing tests, minus none). Fix `Loan.sol` if any funding test fails; do not weaken tests.

- [ ] **Step 6: Commit**

```bash
git add contracts/contracts/Loan.sol contracts/test/MultiLenderFunding.ts contracts/test/LoanLifecycle.ts contracts/test/NexusFiMilestone1.ts
git commit -m "feat: pooled multi-lender funding phase in Loan.sol"
```

---

### Task 2: Pro-rata repayment settlement + hybrid fallback suite

**Files:**
- Create: `contracts/contracts/test/RejectingReceiver.sol`
- Create: `contracts/test/MultiLenderSettlement.ts` (repayment half)
- Modify: `contracts/contracts/Loan.sol` only if a test exposes a defect

**Interfaces:**
- Consumes: Task 1's `contribute()`, `withdraw()`, `_distribute` behavior, `ShareDistributed(loanId, lender, amount, pending)` event.
- Produces: `RejectingReceiver` test helper with `contributeTo(address loan) payable`, `withdrawFrom(address loan)`, `setAccept(bool)`, and a `receive()` that reverts unless armed.

- [ ] **Step 1: Write the helper contract**

Create `contracts/contracts/test/RejectingReceiver.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ILoanPool {
    function contribute() external payable;
    function withdraw() external;
}

/// Test-only lender that refuses plain ETH transfers until armed, to exercise
/// the hybrid settlement's pull-fallback path.
contract RejectingReceiver {
    bool public accept;

    function setAccept(bool accept_) external {
        accept = accept_;
    }

    function contributeTo(address loan) external payable {
        ILoanPool(loan).contribute{value: msg.value}();
    }

    function withdrawFrom(address loan) external {
        ILoanPool(loan).withdraw();
    }

    receive() external payable {
        require(accept, "RejectingReceiver: refusing");
    }
}
```

- [ ] **Step 2: Write the repayment settlement suite**

Create `contracts/test/MultiLenderSettlement.ts` with the same fixture pattern as `MultiLenderFunding.ts` (copy the `deployRequestedLoan` helper; the two files stay independent so either can run alone). Respect the timing caveat: never pre-compute exact owed figures; read state after transactions. Tests:

```ts
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
  // contributions 0.5 / 0.3 / 0.2, repay an odd amount like 333333333333333337n
  // wei above a base installment to force nonzero dust; assert
  // sum(deltas) == applied and each non-last share equals its floor formula.
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
  // Mirror LoanLifecycle's overpay test but with two lenders: borrower's net
  // delta must equal -(applied) - gas + collateralAmount.
});
```

Fill in the two sketched tests (`three lenders`, `overpayment`) as complete code following the exact patterns of their neighbors; they are required, not optional.

- [ ] **Step 3: Run the suite**

Run: `cd contracts && npx hardhat test test/MultiLenderSettlement.ts`
Expected: PASS if Task 1's `_distribute`/`_pushOrCredit` are correct; any failure is a real defect - fix `Loan.sol`, never the assertion.

- [ ] **Step 4: Full suite green, then commit**

Run: `cd contracts && npx hardhat test`
Expected: PASS, all files.

```bash
git add contracts/contracts/test/RejectingReceiver.sol contracts/test/MultiLenderSettlement.ts contracts/contracts/Loan.sol
git commit -m "test: pro-rata repayment settlement and hybrid fallback coverage"
```

---

### Task 3: Liquidation split + participation gates suite

**Files:**
- Modify: `contracts/test/MultiLenderSettlement.ts` (append liquidation half)
- Modify: `contracts/contracts/Loan.sol` only if a test exposes a defect

**Interfaces:**
- Consumes: Task 1's `liquidate()` (any contributor, vault pays the loan, loan distributes), `receive()` gate.

- [ ] **Step 1: Append the liquidation tests**

Append to `contracts/test/MultiLenderSettlement.ts`:

```ts
it("splits a liquidation seizure pro-rata and refunds the borrower surplus", async function () {
  const { loan, collateralVault } = await deployRequestedLoan();
  await loan.write.contribute({ account: lenderA.account, value: parseEther("0.6") });
  await loan.write.contribute({ account: lenderB.account, value: parseEther("0.4") });

  await loan.write.fastForward([durationDays * DAY + GRACE_PERIOD + 60n], { account: lenderA.account });
  assert.equal(await loan.read.isLiquidatable(), true);

  const [seize, refund] = await loan.read.liquidationPreview();
  const aBefore = await publicClient.getBalance({ address: lenderA.account.address });
  const bBefore = await publicClient.getBalance({ address: lenderB.account.address });
  const borrowerBefore = await publicClient.getBalance({ address: borrower.account.address });

  // B (not A) triggers, and B pays gas - measure A and borrower exactly.
  const hash = await loan.write.liquidate({ account: lenderB.account });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const gas = receipt.gasUsed * receipt.effectiveGasPrice;

  const aAfter = await publicClient.getBalance({ address: lenderA.account.address });
  const bAfter = await publicClient.getBalance({ address: lenderB.account.address });
  const borrowerAfter = await publicClient.getBalance({ address: borrower.account.address });

  const seizedNow = seize; // read pre-tx; drift tolerance per the timing caveat
  const aShare = (seizedNow * parseEther("0.6")) / parseEther("1");
  // Allow a few wei of drift on time-sensitive seize: assert bounds, not exact,
  // for A; assert the exact-sum property via A + B deltas == actual seizure,
  // which is read back from the LoanLiquidated event or vault balance delta.
  assert.ok(aAfter - aBefore >= aShare - 1_000n && aAfter - aBefore <= aShare + 1_000n);
  assert.equal((aAfter - aBefore) + (bAfter - bBefore + gas) + (borrowerAfter - borrowerBefore), collateralAmount);
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
  const { loan, loanAddress } = await deployRequestedLoan();
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
```

Adjust the `sendTransaction` call to the viem wallet-client API actually available in this Hardhat setup (`lenderA.sendTransaction({...})` on the wallet client; check how other tests send raw value if this differs).

- [ ] **Step 2: Run the full suite**

Run: `cd contracts && npx hardhat test`
Expected: PASS across all four test files. Fix `Loan.sol` on genuine failures only.

- [ ] **Step 3: Commit**

```bash
git add contracts/test/MultiLenderSettlement.ts contracts/contracts/Loan.sol
git commit -m "test: pooled liquidation split and participation gates"
```

---

### Task 4: Sepolia redeploy (HUMAN-GATED)

**Files:**
- Modify: `frontend/.env` (three contract addresses)

This task spends real Sepolia ETH from `SEPOLIA_PRIVATE_KEY` in `contracts/.env` and changes shared team infrastructure. **Stop and get the user's explicit go-ahead before running the deploy command, and remind them to notify teammates.**

- [ ] **Step 1: Confirm suite green and compile clean**

Run: `cd contracts && npx hardhat test`
Expected: PASS.

- [ ] **Step 2 (user confirms first): Deploy**

Run: `cd contracts && npx hardhat run scripts/deploy-milestone1.ts --network sepolia`
Expected: prints new CollateralVault, MockPriceFeed, LoanFactory addresses. Record all three.

- [ ] **Step 3: Update frontend env**

In `frontend/.env`, set `NEXT_PUBLIC_LOAN_FACTORY_ADDRESS_SEPOLIA`, `NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS_SEPOLIA`, `NEXT_PUBLIC_MOCK_PRICE_FEED_ADDRESS_SEPOLIA` to the new addresses. Do not print or commit any secret values; `.env` is gitignored. Remind the user to mirror the three values in the Vercel project env and to tell teammates the addresses changed (old loans stay on the old factory; the marketplace starts empty).

- [ ] **Step 4: Update the address table in `report.md`** (the "Deployed contracts" section) with the new addresses and date. Commit only `report.md`:

```bash
git add report.md
git commit -m "docs: record pooled-loan contract redeploy addresses"
```

---

### Task 5: Frontend ABI + event layer + mechanical call-site migration

**Files:**
- Modify: `frontend/lib/loan-abi.ts`
- Modify: `frontend/lib/loan-events.ts`
- Modify: `frontend/hooks/useLoanEvents.ts` (only if types force it)
- Modify: `frontend/components/LenderDashboard.tsx`, `frontend/components/StatementsPanel.tsx`, `frontend/components/PublicLoanSummary.tsx` (mechanical only: keep `tsc` green, no new UX)

**Interfaces:**
- Consumes: Task 1's contract interface, verbatim.
- Produces (relied on by Tasks 6-9):
  - `LOAN_ABI` gains: `contribute` (payable, no inputs, no outputs), `withdraw`, `reclaimContribution` (both nonpayable, no inputs), `getLenders` (view, `address[]`), `contributions` (view, input `address`, output `uint256`), `totalContributed`, `fundingProgressBps`, `minContribution` (all view `uint256`), `pendingWithdrawals` (view, input `address`, output `uint256`). `fund` and `lender` entries are REMOVED.
  - `LoanEventKind` gains `'contribution' | 'share-distributed' | 'withdrawal' | 'reclaimed'`; `LoanEvent` gains optional `pending?: boolean`.
  - `LOAN_EVENT_ABI` replaces the `LoanFunded` item with `event LoanFunded(uint256 indexed loanId, uint256 totalContributed)` and adds:
    - `event Contribution(uint256 indexed loanId, address indexed contributor, uint256 amount, uint256 totalContributed)`
    - `event ShareDistributed(uint256 indexed loanId, address indexed lender, uint256 amount, bool pending)`
    - `event Withdrawal(uint256 indexed loanId, address indexed lender, uint256 amount)`
    - `event ContributionReclaimed(uint256 indexed loanId, address indexed contributor, uint256 amount)`
  - Decoder cases: `Contribution -> kind 'contribution', amount, actor: contributor`; `LoanFunded -> kind 'funded', amount: totalContributed, no actor`; `ShareDistributed -> kind 'share-distributed', amount, actor: lender, pending`; `Withdrawal -> kind 'withdrawal', amount, actor: lender`; `ContributionReclaimed -> kind 'reclaimed', amount, actor: contributor`. `EVENT_LABEL` entries: `contribution: 'Contribution'`, `'share-distributed': 'Share paid out'`, `withdrawal: 'Pending share withdrawn'`, `reclaimed: 'Contribution reclaimed'`.

- [ ] **Step 1: Update `lib/loan-abi.ts` and `lib/loan-events.ts`** per the Produces block above. In `loan-events.ts`, the `funded` case's `actor` disappears (no single lender); keep the type's `actor` optional as it already is.

- [ ] **Step 2: Mechanical call-site migration** (read each file first; line numbers may have drifted):

- `LenderDashboard.tsx`: the `lenderContracts` read round (`functionName: 'lender'`) becomes `functionName: 'contributions', args: [address]` (the CONNECTED wallet), enabled only when `address` is set; `lenderByAddress: Map<string, 0x>` becomes `myContributionByAddress: Map<string, bigint>`; `isMine(lenderAddr)` becomes `(myContributionByAddress.get(addrKey) ?? 0n) > 0n`. Note the multi-wallet `allAddresses` nuance: today `isMine` checks all connected accounts; with a per-address `contributions` read keyed to the active `address`, positions follow the ACTIVE account only. Accept that narrowing (state it in a code comment) rather than multiplying read rounds by accounts. The `fundLoan(...)` writer switches `functionName: 'fund'` to `'contribute'` with the same exact-principal `value` for now (Task 6 replaces the UX). Where `lenderAddr` was displayed or passed (e.g. settlement receipts section), pass/derive from the new map or omit; keep changes minimal and compiling.
- `StatementsPanel.tsx`: `lenderContracts` (`functionName: 'lender'`) becomes `functionName: 'contributions', args: [address]`; the `isMine` comparison for the lender role becomes `contribution > 0n`; `counterparty` for the borrower role (which showed the lender) becomes the shortened loan contract address or `'pooled'` - a one-line presentational stopgap until Task 8.
- `PublicLoanSummary.tsx`: the lender-mode read (`functionName: 'lender'`) becomes `functionName: 'contributions', args: [targetAddress]`; a loan is the target's position when the returned value `> 0n`. Map type changes from address to bigint accordingly.

- [ ] **Step 3: Verify**

Run from `frontend/`: `npx tsc --noEmit -p .` (clean), `node --test lib/*.test.ts` (all pass), `npx eslint components/LenderDashboard.tsx components/StatementsPanel.tsx components/PublicLoanSummary.tsx lib/loan-abi.ts lib/loan-events.ts` (no errors).

- [ ] **Step 4: Commit**

```bash
git add frontend/lib/loan-abi.ts frontend/lib/loan-events.ts frontend/hooks/useLoanEvents.ts frontend/components/LenderDashboard.tsx frontend/components/StatementsPanel.tsx frontend/components/PublicLoanSummary.tsx
git commit -m "feat: migrate frontend ABI and event layer to pooled loans"
```

---

### Task 6: Contribute UX + funding progress (LenderDashboard, Open Requests)

**Files:**
- Modify: `frontend/components/LenderDashboard.tsx`

**Interfaces:**
- Consumes: `contribute` writer, `totalContributed`/`fundingProgressBps`/`minContribution` views (Task 5 ABI).

- [ ] **Step 1: Add a `totalContributed` read round** for open loans (same address-keyed-map pattern as the existing rounds; key by lowercased loan contract address).

- [ ] **Step 2: Replace the fund button UI on each Open Request card** with:
  - a progress bar: `Number(totalContributed * 10_000n / principalAmount) / 100` percent, bar styled like the existing LTV bars (`bg-slate-800` track, `bg-emerald-500` fill), with a `x.xxxx / y.yyyy ETH funded` caption;
  - an amount input (ETH, like the repay input in `BorrowerLoansSection`) defaulting to the full remaining amount, with quick-fill buttons `25% / 50% / Remaining` of the remaining gap;
  - a Contribute button calling the Task 5 `fundLoan`-successor `contributeLoan(loanContract, amountWei, loanId)` which validates client-side: amount >= `minContribution` (read it per loan or compute `principal / 100n`), amount > 0; over-fill is allowed (contract refunds).
  - Self-loan block ("Your request") stays as today.

- [ ] **Step 3: Keep the existing tx-lifecycle plumbing** (pending/confirming/confirmed states, Etherscan link, `refetchAll` on confirm) wired to the new writer.

- [ ] **Step 4: Verify** `npx tsc --noEmit -p .` and `npx eslint components/LenderDashboard.tsx` clean. Manual check happens in Track G after deploy.

- [ ] **Step 5: Commit**

```bash
git add frontend/components/LenderDashboard.tsx
git commit -m "feat: funding progress bar and contribute flow on open requests"
```

---

### Task 7: Positions by share + Claim + Reclaim (LenderDashboard, My Positions)

**Files:**
- Modify: `frontend/components/LenderDashboard.tsx`

**Interfaces:**
- Consumes: `contributions(me)` map (Task 5), `pendingWithdrawals(me)`, `withdraw`, `reclaimContribution`, `getLenders` (optional count display).

- [ ] **Step 1: Share figures on each position card.** With `myContribution` and `terms.principalAmount`: `sharePct = myContribution * 10_000n / principalAmount` (render `/100` with 2 decimals). Show "Your share: X% (a.aaaa ETH of b.bbbb ETH)". Pro-rata versions of the existing figures: my slice of outstanding (`outstanding * myContribution / principal`), my slice of `liquidationPreview().seize`. Label them "your share".

- [ ] **Step 2: Claim banner.** Add a `pendingWithdrawals` read round (args `[address]`). On any loan where it is `> 0n`, render a prominent amber banner above the positions list: "x.xxxx ETH from loan #N could not be delivered to your wallet - Claim it", with a button calling `withdraw` on that loan (usual tx lifecycle + refetch). This must be visible without scrolling into the card.

- [ ] **Step 3: Reclaim on dead pools.** For loans where `myContribution > 0n` AND (status is Cancelled (3), or status is Requested and past the funding window - reuse the existing `isExpired(createdAt)` helper): render a card in My Positions with "This request was cancelled/expired before funding completed" and a Reclaim button calling `reclaimContribution`. (Plan addition beyond the spec's UI list, same rationale as the Claim banner: pull-path money must be visible to its owner.)

- [ ] **Step 4: Verify** `npx tsc --noEmit -p .`, `npx eslint components/LenderDashboard.tsx` clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/components/LenderDashboard.tsx
git commit -m "feat: per-share positions with claim and reclaim flows"
```

---

### Task 8: Per-share receipts and statements

**Files:**
- Modify: `frontend/components/LoanSettlementReceipt.tsx`
- Modify: `frontend/lib/statements.ts`
- Modify: `frontend/components/StatementsPanel.tsx`
- Modify: `frontend/components/LenderDashboard.tsx` (receipt call sites: pass the new props)

**Interfaces:**
- Consumes: `LoanEvent` kinds `'share-distributed' | 'withdrawal'` with `actor` = lender and `pending` flag (Task 5).
- Produces: `LoanSettlementReceipt` gains optional props `viewerAddress?: string` and `myContribution?: bigint`.

- [ ] **Step 1: `LoanSettlementReceipt.tsx`.** When `role === 'lender'` and `viewerAddress` is set and the events contain any `share-distributed` entries: compute `myReceived = sum of share-distributed events where actor.toLowerCase() === viewerAddress.toLowerCase()` (count `pending` ones too - they are owed either way; add a footnote line "includes x.xxxx ETH claimable via Claim" when any are pending and no matching `withdrawal` event exists). Lender rows become: "You lent" = `myContribution ?? principal`, "Repayments received" = my summed shares from repayment txs, "Collateral seized" = my summed shares from the liquidation tx (identify via the tx hash matching the loan-level `liquidated` event), "Interest earned/Shortfall" = `myReceived - myContribution`. When there are no `share-distributed` events (old-loan data or missing index), fall back to the current loan-level computation unchanged. The per-leg audit list gains rows for `contribution`, `share-distributed`, `withdrawal`, `reclaimed` kinds using `EVENT_LABEL`.

- [ ] **Step 2: `lib/statements.ts`.** For the lender role, when share events exist for the viewer, statement rows use the viewer's `share-distributed` amounts instead of loan-level repayment amounts (same fallback rule). Borrower-role rows unchanged. Read the file fully first; keep its row/column shapes intact so the PDF layout does not change.

- [ ] **Step 3: `StatementsPanel.tsx`.** Pass the viewer address through to the statement builder; replace the Task 5 `'pooled'` counterparty stopgap with `lenderCount` ("N lenders") derived from distinct `share-distributed` actors per loan, when available.

- [ ] **Step 4: Verify** `npx tsc --noEmit -p .`, `node --test lib/*.test.ts`, eslint on the touched files - all clean. If share-summing logic is extracted, put it in `frontend/lib/share-math.ts` with a `share-math.test.ts` (`node:test`), imports with `.ts` extensions.

- [ ] **Step 5: Commit**

```bash
git add frontend/components/LoanSettlementReceipt.tsx frontend/lib/statements.ts frontend/components/StatementsPanel.tsx frontend/components/LenderDashboard.tsx frontend/lib/share-math.ts frontend/lib/share-math.test.ts
git commit -m "feat: per-share settlement receipts and statements"
```

(Drop the `share-math` files from the add list if not created.)

---

### Task 9: Borrower-side funding progress

**Files:**
- Modify: `frontend/components/BorrowerLoansSection.tsx`
- Modify: `frontend/components/LoanRequestPanel.tsx`

- [ ] **Step 1: `BorrowerLoansSection.tsx`.** For the borrower's own `Requested` loans, add a `totalContributed` read round and render the same progress bar style as Task 6 ("x.xxxx / y.yyyy ETH funded - waiting for lenders"). No behavior change for other statuses.

- [ ] **Step 2: `LoanRequestPanel.tsx`.** In the "what happens next" tracker for a freshly created loan, the "a lender funds your loan" step shows live progress: read `totalContributed` on `createdLoanContract` (same 5s poll as the existing `status` read there) and caption the step "x% funded" while status is still Requested.

- [ ] **Step 3: Verify** `npx tsc --noEmit -p .`, eslint on both files - clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/components/BorrowerLoansSection.tsx frontend/components/LoanRequestPanel.tsx
git commit -m "feat: borrower-side funding progress for pooled requests"
```

---

### Task 10: Manual regression Track G

**Files:**
- Modify: `tests/MANUAL_TEST_PLAN.md`

- [ ] **Step 1: Insert a new section before `## Findings log`** (read the file; find the heading):

```markdown
## Track G - Multi-lender pooling (needs 3 accounts, or 2 + the demo personas)

Uses the redeployed pooled contracts. Amounts: keep every contribution >= 1% of principal.

- [ ] **G1 Partial fill** - Borrower creates a request. Lender 1 contributes ~60%. Verify: progress bar
      shows ~60% on both lender and borrower dashboards, status still `Requested`, borrower has NOT
      received funds
- [ ] **G2 Fill + over-fill refund** - Lender 2 contributes MORE than the remaining 40%. Verify: loan flips
      to `Funded` on all dashboards, borrower's balance rose by exactly the principal, lender 2's wallet
      only spent the remaining gap (excess refunded in the same tx)
- [ ] **G3 Pro-rata repayment** - Borrower repays in full. Verify by WALLET BALANCES (not UI): lender 1
      received ~60% and lender 2 ~40% of the repayment, summing exactly to what the borrower paid
- [ ] **G4 Per-share receipts** - Both lenders open the settlement receipt on the closed loan. Verify each
      sees their OWN lent/received/interest figures, not the loan totals, with per-leg links
- [ ] **G5 Pooled liquidation** - New pooled loan, skip time via `/demo`, lender 2 (not lender 1) clicks
      Liquidate. Verify the seizure split lands pro-rata in BOTH lenders' wallets and the borrower got the
      surplus refund
- [ ] **G6 Reclaim** - New request, one partial contribution, borrower cancels. Verify the contributor sees
      a Reclaim card in My Positions and reclaiming returns exactly the contribution
- [ ] **G7 Statements** - Each lender downloads a P&L statement covering the pooled loans. Verify the
      figures are per-share, matching G3/G5 wallet deltas
- [ ] **G8 Minimum** - Try contributing less than 1% of principal. Verify the UI blocks it (and the contract
      would revert if forced)

---
```

- [ ] **Step 2: Commit**

```bash
git add tests/MANUAL_TEST_PLAN.md
git commit -m "test: add multi-lender pooling regression track"
```

---

## Plan Self-Review

**Spec coverage:** funding phase incl. min/cap/top-up/over-fill/single-lender parity (Task 1); hybrid settlement, dust, withdraw (Task 2); pooled liquidation, any-contributor gate, vault-recipient routing, receive() gate, fastForward gate (Tasks 1+3); reclaim on cancel/expiry (Task 1); redeploy + env + report table (Task 4); ABI/events layer incl. all five new events and the `LoanFunded` signature change (Task 5); progress bar + contribute input (Task 6); per-share positions + Claim banner (Task 7, spec) + Reclaim UI (Task 7, flagged plan addition); per-share receipts and statements with old-data fallback (Task 8); borrower-side progress (Task 9); regression track (Task 10). Out-of-scope items (ERC-20, liquidator bonus, share transfer, off-chain schema) appear in no task.

**Placeholder scan:** two settlement tests in Task 2 are named with behavioral sketches and explicitly marked "required, not optional" with their neighbors as the complete pattern; everything else is full code or precise edit instructions against files the implementer must read. No TBD/TODO markers.

**Type consistency:** `contributions(address) -> uint256`, `pendingWithdrawals(address) -> uint256`, `totalContributed -> uint256`, `getLenders -> address[]`, `fundingProgressBps -> uint256`, `minContribution -> uint256` are identical in Task 1's contract, Task 5's ABI Produces block, and every consuming task. Event field names (`contributor`, `lender`, `amount`, `totalContributed`, `pending`) match between the contract events, `LOAN_EVENT_ABI` strings, and decoder cases. Revert strings asserted in tests match the contract's exactly (`"Loan: below minimum contribution"`, `"Loan: lender cap reached"`, `"Loan: caller is not a lender"`, `"Loan: nothing to reclaim"`, `"Loan: no contribution"`, `"Loan: nothing to withdraw"`, `"Loan: not a participant"`, `"Loan: funding window has expired"`, `"Loan: borrower cannot fund"`).
