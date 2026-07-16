---
name: layer1-design-decisions
description: Key Layer 1 design decisions for NexusFi personas and risk scoring — Charlie mixer flag, unscored features, testnetWallet field
metadata:
  type: project
---

## Charlie's mixerInteraction = false (deliberate PDF deviation)

The PDF spec (page 30-31) lists Charlie with `"mixer_interaction": true`. With `true`, the scorer returns −1.0 (weight 0.15 → −0.150), dropping Charlie's overall score to −0.170 → Tier C. Since the platform needs one persona per tier (A/B/C), Charlie's `mixerInteraction` is intentionally `false` to score +0.025 → Tier B. Documented via comment in `borrower-personas.ts` line 66. The test in `risk-explainer.test.ts` explicitly verifies that mixer=true would produce Tier C.

**Why:** PDF spec error or ambiguity — numeric scoring with mixer=true contradicts the narrative that Charlie is the Tier B demo persona.
**How to apply:** Do not "fix" Charlie's mixerInteraction to true — it will break the three-tier demo.

## Unscored features (Phase 2)

- `sanctionProximity`: present in `SimulatedOnChainFeatures`, populated for all personas (all false), but NOT in `FEATURE_SCORING_GUIDE` and no scorer function. Requires on-chain OFAC screening API for real implementation.
- `loanPurpose`: present in `OffChainMetadata`, but NOT scored. Requires purpose→default correlation model.

Both are documented in the `FEATURE_SCORING_GUIDE` JSDoc comment in `risk-explainer.ts`.

## testnetWallet field added to BorrowerPersona

PDF schema includes `"testnet_wallet"` per persona. Added `testnetWallet: string` to `BorrowerPersona` type. Values are Hardhat built-in accounts (deterministic private keys 1, 2, 3):
- Alice: `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` (account[1])
- Charlie: `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` (account[2])
- Bob: `0x90F79bf6EB2c4f870365E785982E1f101E93b906` (account[3])

## Test runner

Tests use Node.js native `node:test` + `node:assert`. Run with:
`node --experimental-strip-types --test lib/risk-explainer.test.ts`

The existing `borrower-risk.test.ts` and `loan-terms.test.ts` fail due to pre-existing import-extension issue (imports without `.ts` extension). New tests always use full `.ts` extension to avoid this.

**Why:** Pre-existing issue, not a regression. node:test requires explicit extensions with `--experimental-strip-types`.
