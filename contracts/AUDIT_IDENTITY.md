# Pvium identity and generated verifier review

Date: 2026-09-27.

**Latest status, fourth review:** all previously reported revocation-cache payout paths are
fixed. Strictly older proofs remain rejected, equal-time proofs cannot replace a void cached
wallet, and both normal and combined proof-and-sweep calls require a current cache before
unconstrained funds are paid. Future-timestamp recovery remains bounded to 15 minutes. See
[Fourth review](#fourth-review-2026-09-27). Earlier reviews are retained below as historical
evidence.

**Follow-up review:** the revised working tree was audited again on 2026-09-27. The original
cached-sweep path is blocked, final-key removal works, and local deployment succeeds. The
revision-based recovery introduces a replay issue and leaves a bounded timestamp-recovery
issue. See [Follow-up review](#follow-up-review-2026-09-27) for the current findings; the first
review below is retained as historical evidence.

Scope: the working-tree versions of `src/PviumIdentity.sol` and
`src/PviumZKVerifier.sol`, with the circuit's public-output encoding, `PviumVerifier`,
vault authorization caching and deployment callers examined where they affect those contracts.
This includes the uncommitted signer-key-management changes. Production sources were not
modified by this review.

Source SHA-256 values at review time:

| File | SHA-256 |
| --- | --- |
| `src/PviumIdentity.sol` | `bc71e34fed53ab849b41fa54043a46000bad24f41762628f54649c2237d6d278` |
| `src/PviumZKVerifier.sol` | `d162b3909afe70f12a77fd3fc1b27909a21796452bca718723a4c6245bdb78ab` |

Three findings were confirmed: two concern signer-revocation behavior and one concerns the
local deployment script. No proof-verification bypass was found in the generated verifier.
The cryptographic review covered implementation boundaries, transcript binding, decoding,
range checks, proof length and precompile failure handling. It was not an independent
soundness proof of UltraHonk, an audit of the trusted setup, or a complete circuit audit.

## 1. High: signer revocation does not invalidate cached vault authorization

Locations: `src/PviumIdentity.sol:158`, `src/PviumIdentity.sol:242`,
`src/P2IDVault.sol:459`, `src/P2IDVault.sol:496`, `src/P2IDVault.sol:312`,
`src/P2IDVault.sol:323`.

`removeSignerKey` prevents subsequent proof verification under a removed key. However,
`P2IDVault._present` stores only the returned wallet and issue time. Later unconstrained
sweeps use that cached wallet without calling `PviumIdentity` or checking which signer
authenticated it. Removing the signer therefore leaves its previously established payout
authorization active, including for funds arriving after removal.

This becomes a theft risk if an accepted signing key is compromised and an attacker uses it
to authenticate an attacker-controlled wallet before revocation. Revocation stops new proof
submissions but does not contain the attack on initialized vaults. This requires compromise
of an accepted identity signing key; it is not an unprivileged ZK forgery. Constrained claims
submit a proof again and therefore do enforce the updated signer set.

Reproduction using the real ZK fixture:

1. Register the fixture's signer and a second valid signer.
2. Submit the fixture proof through `PviumVerifier` to initialize a vault's wallet.
3. Remove the fixture's signer. Both direct verification and another `refreshProof` now
   revert with `UnknownSigner`.
4. Fund a new unconstrained deposit and call `sweep`. The cached wallet receives it.
5. Send additional untracked tokens and call `sweepUntracked`. The same wallet receives them.

The reproduction establishes the continued authorization using a real proof. It does not
fabricate a signature under Privy's private key or claim that the fixture wallet is compromised.

Recovery is additionally sensitive to timestamps: the vault records monotonic issue times
per verifier and for direct transfers. A compromised signer can choose a future `iat` within
the circuit's ten-digit format. Removing that signer does not clear those floors, so a
legitimate replacement proof can remain too old. This extension follows from the circuit and
vault logic; the reproduction does not generate a future-dated forged token.

Recommendation: make cached authorization revocable. For example, propagate a signer
identifier or verifier authorization epoch with the verification result, store it with the
cached wallet, and validate it before every payout. Define how revocation invalidates both
cached ownership and the associated freshness state without restoring older unsafe wallets.
A pause or signer check that only runs during proof submission does not fix cached sweeps.

## 2. Medium: a compromised final signer cannot be revoked immediately

Locations: `src/PviumIdentity.sol:158`, especially the `signerKeyCount == 1` guard at line 161;
`src/PviumIdentity.sol:126` and `src/PviumIdentity.sol:144`.

The contract permits a deployment with one signer, and normal removals can leave one signer.
If that key is compromised, `removeSignerKey` reverts with `LastSignerKey`. When no replacement
proposal is already mature, a new trusted key cannot be activated for 14 days. The compromised
key remains accepted throughout that interval. The same containment failure applies when all
currently registered keys need revocation: the final compromised key must remain trusted.

The nonempty-key invariant is explicit and tested in the existing suite, but it conflicts
with using immediate removal as an emergency response to a leaked key. Keeping a compromised
verification path available is not equivalent to keeping legitimate claims available.

Reproduction: leave only the fixture signer, attempt removal, propose a replacement, advance
to one second before activation, and verify that the original fixture proof is still accepted.
The added audit test reproduces this without assuming control of the fixture's private key.

Recommendation: allow the accepted set to become empty while preserving the owner's ability
to propose and activate replacement keys, or add an emergency disable mechanism. Apply the
revocation semantics to cached vault authorization as well (finding 1). Recovery must not
require leaving a compromised signer active or removing the delay on adding trust.

## 3. Low: the local deployment script uses the previous constructor ABI

Locations: `scripts/deploy-local.ts:19`, `src/PviumIdentity.sol:98`.

The constructor now takes `(verifier, circuitVersion, owner, signerXs, signerYs)`. The local
script still supplies `(verifier, circuitVersion, signerXs, signerYs)`. Ethers attempts to
resolve the X-coordinate array as the owner address and fails with `INVALID_ARGUMENT:
unsupported addressable value`. The local/Dart-example deployment path cannot complete.

Reproduced on the in-process Hardhat network with:

```sh
yarn hardhat run scripts/deploy-local.ts
```

Recommendation: pass an explicit owner or `ZeroAddress`, according to the intended local
configuration, and add a smoke test for that entry point. The deterministic deployment
library and updated test helper already supply the owner argument.

## Governance and caller responsibilities

- Key additions trust the owner. `_isOnCurve` establishes a valid P-256 point; `url` and `kid`
  are published metadata, not an onchain check that Privy controls the key. This is an explicit
  governance trust boundary, not a cryptographic bypass.
- The statement in `PviumIdentity`'s introductory comment that payees and funders can exit
  before a proposed key activates is not guaranteed. The owner can immediately remove a key
  needed by an uninitialized claimant while another key remains, and recorded deposits can
  have refund windows longer than 14 days. Direct transfers have no refund path. Existing
  cached ownership can allow some users to exit, but not all. Document this limitation rather
  than describing the proposal delay as a guaranteed withdrawal window.
- `verifyIdentity` and `verifyAttestation` authenticate historical attestations. They do not
  enforce token expiry, a current-login requirement, a caller challenge or one-time use.
  The existing expired fixture is accepted by design; callers must apply their own freshness
  and authorization policy. This was not classified as a new finding.
- The constructor verifies that the verifier address has code, not that it is the intended
  verifier/VK. Deployment tooling and consumers must authenticate the verifier and its linked
  libraries. The circuit-version number is deployment metadata, not a separate proof binding.

## Generated verifier checks and validation

- Regenerated into a temporary file with the installed `bb 5.0.0-nightly.20260522`, using
  `circuit/target/proof_email/vk`. After the repository's prescribed contract rename, the
  result is byte-for-byte identical to `src/PviumZKVerifier.sol`.
- The VK SHA-256 matches `circuit/version.json`:
  `1c799113fea7ad5b9814605a3cda138e441cee6778ff29d62940e61ebcef822b`.
- The verifier's 19 public inputs consist of 11 application inputs and 8 proof-carried
  pairing limbs. This agrees with the wrapper's 11-input interface.
- All application public inputs are included in the transcript and public-input delta.
  Changing each of the 11 inputs was rejected, as was adding the scalar-field modulus to
  each input.
- The wrapper's narrowing casts and `_join` rely on the proved circuit's ranges. The circuit
  constructs 128-bit halves from bytes and binds the EVM wallet; high-bit modifications that
  would be discarded by the wrapper were rejected by the actual ZK verifier. No truncation
  bypass was demonstrated.
- Out-of-range recursion limbs, G1 coordinates and proof scalars were rejected. An all-zero
  proof was rejected. Existing tests cover incorrect proof/public-input lengths.
- A one-bit mutation in each of the fixture's **334 serialized 32-byte proof words** was
  rejected. This is bounded mutation coverage of one valid proof, not proof of soundness
  against all adversarially constructed proofs.
- Existing `PviumZKVerifier.test.ts` and `PviumVerifier.test.ts`: **41 passed**.
- Added `PviumIdentity.audit.test.ts`: **6 passed**, including both revocation reproductions
  and the encoding/mutation checks. The finding reproductions assert current behavior and
  should be inverted or replaced with regression assertions when fixes are made.

Run from `contracts/`, with the repository's prescribed Node installation first on `PATH`:

```sh
yarn hardhat test test/PviumZKVerifier.test.ts test/PviumVerifier.test.ts
yarn hardhat test test/PviumIdentity.audit.test.ts
```

No production contract, generated verifier, circuit, key set or deployment was changed by
this audit. The additions are this report and the audit test file.

## Follow-up review (2026-09-27)

The follow-up reviewed the new `keySetRevision` / `revision()` / `ownerRevision` flow, final-key
removal, timestamp recovery, and the corrected local deployment script. Production sources
were not changed during this review.

| Reviewed file | SHA-256 |
| --- | --- |
| `src/PviumIdentity.sol` | `08dc283b4637a10639c290e2568622dbfd39e755ca5ed10ab8362338915d4fcf` |
| `src/PviumZKVerifier.sol` | `d162b3909afe70f12a77fd3fc1b27909a21796452bca718723a4c6245bdb78ab` |
| `src/P2IDVault.sol` | `de02584fbd1738cf0fb3c99df79bc151d7bb13066f37056204cb75f1d16ee933` |

### Previous findings

1. **Original cached-sweep bypass closed, recovery still unsafe.** All three proofless payout
   entry points reject an outdated cached revision. The real-proof regression verifies this.
   However, the replacement recovery logic permits an older proof to restore a superseded
   wallet, as detailed in F1 below.
2. **Final-key removal fixed.** The accepted key count may reach zero; proof verification fails
   until a replacement key is activated. The regression also confirms recovery after the delay.
3. **Local deployment fixed.** The script supplies the owner argument and successfully deploys
   both contracts on the in-process Hardhat network.

### F1. High: unrelated key revocation re-enables superseded wallet proofs

Locations: `src/P2IDVault.sol:475–482`, `src/PviumIdentity.sol:163–168`.

Every signer removal increments one global revision. If a vault's cached revision differs,
`_present` sets the effective previous issue time to zero. It accepts and stores any proof
that the current verifier still recognizes, even when that proof was already superseded by a
newer wallet proof. Removing signer B therefore makes older proofs from still-accepted signer
A eligible again.

Reproduction:

1. Establish wallet W1 at issue time 1000, then rotate to W2 at time 2000. Both proofs remain
   cryptographically valid under signer A. Replaying W1 initially fails with `ProofTooOld`.
2. Fund an unconstrained recorded deposit.
3. Revoke a different signer B, incrementing the global revision.
4. Replay the old W1 proof. The effective issue-time floor is zero, so it becomes the cached owner.
5. Sweep the recorded deposit to W1. The test confirms W1 receives 100 tokens and W2 receives none.

An attacker who controls a superseded wallet and retains its old proof can exploit an ordinary
key rotation. This does not require signer-key compromise or malicious governance. The old
proof must still be accepted by a remaining signer. A newer proof can restore W2, but the
attacker can claim before that transaction executes.

The separate `untrackedProofIat` still blocks old W1 from receiving direct transfers in this
scenario; it does not protect recorded deposits. Constrained claims also use `_present` and
lose the old freshness check, although they additionally require valid constraint evidence.

The reproduction uses `MockIdentityVerifier` to model two historical attestations that remain
valid across removal of an unrelated signer. It demonstrates the vault state transition, not
a cryptographic forgery. The real `PviumIdentity` increments the same global revision for any
key removal, and `PviumVerifier` forwards that revision without identifying the proof's signer.

Recommendation: retain freshness information for attestations whose trust source remains
valid. Record enough provenance to distinguish a revoked signer from an unaffected signer
before clearing a wallet's freshness history. Alternatively, define an authenticated recovery
transition that rejects pre-recovery historical proofs. A global revision mismatch alone is
insufficient reason to reset the issue-time floor to zero.

### F2. Medium: revoked future timestamps still block direct-transfer recovery

Locations: `src/P2IDVault.sol:474–485`, `src/P2IDVault.sol:329–331`,
`src/P2IDVault.sol:502–503`.

The new future-time check accepts issue times up to one day ahead. A compromised signer can
therefore still raise `untrackedProofIat` to a future value before revocation. After revocation,
a valid proof under the new revision replaces the per-verifier wallet and timestamp, but the
separate direct-transfer floor is only ever increased. The legitimate wallet is initialized
successfully while direct-transfer payouts remain blocked by the revoked proof's timestamp.

The follow-up reproduction accepts a synthetic proof dated nearly one day ahead, increments
the revision to represent revocation, and accepts an honest current-time proof for another
wallet. `sweepUntracked` then reverts with `ProofTooOld`, and an ordinary sweep leaves all
untracked tokens in the vault. Waiting past the poisoned timestamp alone still does not help:
the recipient must submit another proof whose issue time meets that floor.

Unlike the earlier unbounded future-timestamp risk, the new cap bounds the time until an
honestly issued recovery token can satisfy the floor to roughly one day after the malicious
submission. This is a temporary denial of access, conditional on signer compromise, rather
than a permanent lock or a direct theft path. The test models accepted attestations with a
mock; it does not generate a forged Privy token.

Recommendation: track the trust source of the direct-transfer freshness floor and define
its invalidation when that source is revoked. Coordinate this with F1: indiscriminately clearing
all freshness history on every revision would reopen historical-wallet replay. If the bounded
delay is an accepted recovery policy, document it explicitly and provide tooling to obtain and
submit the required later proof; the current comment promising recovery with the next token
does not hold for a token issued before the poisoned timestamp.

### Follow-up validation

- Full contract suite on the final seven-day-delay revision: **119 passed**, including the
  updated real-proof revocation regressions, both new follow-up reproductions and all
  **334 proof-word mutation checks**.
- The two new reproductions assert the unsafe behavior described above; passing does not
  mean the findings are fixed.
- Local deployment smoke test: passed with `yarn hardhat run scripts/deploy-local.ts` on the
  in-process Hardhat network.
- Generated verifier was independently regenerated into a temporary file again and matches
  the checked-in source after the prescribed rename. Its source hash is unchanged. No new
  generated-verifier bypass was identified; the original cryptographic scope limits still apply.

Reproduce the new findings from `contracts/`:

```sh
yarn hardhat test test/PviumIdentity.audit.test.ts --grep 'follow-up audit'
```

During the follow-up review, the signer-addition delay changed from 14 days to 7 days. The
follow-up source hash above includes that change; neither new finding depends on its duration.
The earlier governance caveat remains: immediate signer revocation can disable claims during
the proposal interval, so that interval is not a guaranteed exit window for all users.

## Third review (2026-09-27)

Reviewed vault SHA-256: `6160d641fb0d2d431559646cd89d94b917c7d89b72d9b26677e3135c06142620`.
`PviumIdentity.sol` and `PviumZKVerifier.sol` retain their second-review hashes.

### Resolution of the second review

- **F1, strictly older proofs: fixed.** `_present` retains `latestProofIat` across revisions.
  A proof at time 1000 cannot replace an owner established at time 2000 after an unrelated
  signer removal. The updated regression verifies rejection and subsequent legitimate recovery.
- **F2, future timestamp: mitigated to a bounded recovery delay.** `FUTURE_SLACK` is now 15
  minutes. Both the per-verifier and direct-transfer floors remain intact. A forged timestamp
  accepted immediately before revocation can delay recovery until a legitimate token reaches
  that timestamp, at most 15 minutes ahead of the chain at submission. Obtaining and presenting
  that new proof is still required; waiting alone does not refresh authorization. The updated
  regression verifies recovery. Treat this as an explicit recovery-policy limitation rather
  than describing the floor as cleared on revocation.

### T1. Medium: equal-time proofs can replace the cached wallet after revocation

Location: `src/P2IDVault.sol:479–488`, especially `!fresh` in the owner-update condition.

The retained timestamp rejects strictly older proofs, but an equal timestamp passes. When the
revision changed, `!fresh` then forces the incoming wallet into storage even if it differs from
the previous owner. Before the revision changes, the identical proof preserves the previous
wallet. This contradicts both the `_present` comment and `P2ID.md`'s equal-time owner rule.

Reproduction:

1. Establish wallet W2 at issue time 2000.
2. Submit a valid W1 proof also at time 2000. W2 remains the recorded owner.
3. Fund a recorded deposit of 100 tokens and transfer 50 additional tokens directly.
4. Remove an unrelated signer, changing the verifier revision while both proofs remain valid.
5. Submit the same W1 proof again. W1 becomes the cached owner and receives all 150 tokens
   through a sweep. The direct-transfer floor also permits payout because the timestamps match.

The attacker must control the alternative wallet and possess an equally recent proof accepted
by a remaining signer. This can arise from separate linked-wallet proofs over one token or
different tokens issued within the same second. It does not let an arbitrary wallet fabricate
a proof, and it is narrower than the strictly older-proof replay from the previous review.
The added test uses the mock verifier to isolate this transition; it does not claim a ZK forgery.

Recommendation: separate revalidation of the cached owner from changing that owner. At the
same timestamp, only the previously recorded wallet should re-establish the cache. Require a
strictly newer attestation to select a different wallet, including after a revision change.
Specify separately how constrained claims treat equally recent linked wallets; preserving the
cached owner must not silently redefine those existing semantics.

### Third-review validation

- Full contract suite: **120 passed**, including the updated recovery regressions and all
  **334 proof-word mutations**.
- Additional equal-time reproduction: **1 passed**, run separately after the full suite had
  loaded its tests. It asserts the vulnerable behavior, not a fix.
- Generated-verifier source hash is unchanged from the generator-verified version. No new
  generated-verifier bypass was identified within the previously stated scope.
- Production contracts were not modified. This pass adds the reproduction and report update.

Reproduce T1 from `contracts/`:

```sh
yarn hardhat test test/PviumIdentity.audit.test.ts --grep 'equal-time'
```

## Fourth review (2026-09-27)

Reviewed vault SHA-256: `6b07220750557450806a9b808ec7bd34b8b928b0cc9f2ed970a98c26728a63e7`.
`PviumIdentity.sol` (`08dc283b4637a10639c290e2568622dbfd39e755ca5ed10ab8362338915d4fcf`)
and generated `PviumZKVerifier.sol`
(`d162b3909afe70f12a77fd3fc1b27909a21796452bca718723a4c6245bdb78ab`)
are unchanged from the preceding pass.

### Resolution of T1 and the combined-sweep follow-up

The equal-time transition now restores `ownerRevision` only when the proof resolves to the
wallet already cached. An equal-time proof for another wallet is still verified for paths that
require an immediate proof, but it cannot replace the stored payout wallet. A strictly newer
proof is required to change that wallet.

The initial T1 fix left a separate payout path: `refreshProofAndSweep` could verify such an
equal-time proof and then call `_sweepDefault` while the cached owner was still void after a
revision change. `_sweepDefault` now resolves its recipient through `_ownerOf`, which checks
the verifier is claimable, that an owner exists, and that `ownerRevision` matches the current
revision. This covers both `sweep` and `refreshProofAndSweep`; `sweepDeposits` and
`sweepUntracked` already take the same freshness check. The prior reproduction now reverts
with `OwnerRevoked`, and a proof one second newer can establish the new wallet and sweep in
the same call.

No new exploitable issue was identified in the reviewed `PviumIdentity`, `PviumVerifier`,
vault revocation integration, or unchanged generated verifier. The 15-minute future-issue-time
bound remains a documented recovery-policy limitation.

### Fourth-review validation

- The focused identity and generated-verifier audit suite passed: **10 tests**, including all
  334 serialized-proof word mutations and the combined-sweep regression.
- The complete contracts suite passed: **123 tests**.
- `git diff --check` reported no whitespace errors.
- This review did not modify production Solidity; it updates this audit record.

## Generated verifier review (2026-09-27)

Reviewed generated `PviumZKVerifier.sol` SHA-256:
`d162b3909afe70f12a77fd3fc1b27909a21796452bca718723a4c6245bdb78ab`.
The verifier was regenerated with the pinned `bb 5.0.0-nightly.20260522` from
`circuit/target/proof_email/vk`; after the repository's prescribed contract rename, the output
matched byte-for-byte. The verification-key SHA-256 is
`1c799113fea7ad5b9814605a3cda138e441cee6778ff29d62940e61ebcef822b`, matching
`circuit/version.json`.

No verifier-boundary bypass was identified. The generated verifier checks the exact proof
length before parsing, requires all eleven application public inputs to be canonical field
elements before transcript generation, binds the eight recursion pairing limbs into that same
transcript, constrains limb widths and reconstructed pairing coordinates, and uses the BN254
precompiles for point and pairing validation. Invalid encodings revert or return a failed
pairing result; they do not return `true`.

### Generated-verifier validation

- `PviumZKVerifier` plus identity and adversarial suites: **40 passed**.
- The valid fixture verifies. Every one of its **334** serialized proof words was mutated and
  rejected independently.
- All application public-input bit mutations, modulus aliases, high-bit wrapper-cast attempts,
  malformed proof length, incorrect input count, invalid pairing limbs, invalid point
  coordinates, and invalid scalar encodings were rejected.
- Deployed verifier bytecode is **18,441 bytes**, below EIP-170's 24,576-byte limit.

This is an implementation-boundary review, not an independent proof of UltraHonk soundness,
the circuit constraints, or the underlying trusted setup. Production Solidity was not modified.
