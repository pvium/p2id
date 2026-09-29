# PviumP2IDVaultProxy review: reentrancy and post-hook checks

Date: 2026-09-29, sixth review. Supersedes the fifth review for the current working tree.
Scope: proxy, P2IDVault proof hook, factory registration/default-selection integration, interfaces,
and local regression tests. No deployed contracts or arbitrary future implementations were audited.

## Result

No new actionable security vulnerability was identified in the current proxy/P2IDVault pairing.
The new upgrade guard and post-hook checks behave as intended in the tested failure paths.
This review adds six regression cases and corrects comments; it does not change production
execution logic.

The existing **low-severity administrative configuration gap** remains in the factory's manual
registration path: proposeImplementation checks code presence but not the raw target's factory
binding. An owner can register an implementation bound to another factory, and a vault owner can
select it. The proxy's immutable factory still supplies upgrade authorization, while delegated
P2IDVault code can consult the other factory's configuration. This is not an unprivileged registry
bypass. The existing factory audit regression reproduces it. The deterministic deployment and
default-selection paths check the raw binding, but do not close the manual path.
See PviumP2IdVaultFactory.sol:150 and AUDIT_PVIUM_P2ID_VAULT_FACTORY.md.

## Upgrade strategy

The proxy verifies the identity proof once through the current default verifier. The proven wallet
must equal the caller; the derived vault address, registered target, timestamp bound, upgrade history,
and readable vault freshness floors must also pass. The verifier call is a Solidity view call.

After writing the implementation and upgrade record, the proxy invokes the new implementation's
acceptOwnerProof through a self-call. P2IDVault accepts only self-calls, applies its revision and
freshness rules, and requires the resulting owner to match the proven wallet. The proxy then checks
the canonical hook acknowledgement, unchanged target implementation, reported owner, and reported
proof floor. Any failure reverts the entire transaction.

A second cryptographic proof verification inside the hook would duplicate work for this pairing.
The self-call authorization, shared state-application logic, and atomic rollback remain the relevant
controls. Adding an arbitrary self-call execution path to a future implementation would require
revisiting the hook's authorization assumptions.

## New regression coverage

Five cases reject a hook after it writes vault storage and returns the correct acknowledgement:

- A different reported owner.
- A reported proof floor below the accepted proof's issue time.
- An owner getter that reverts.
- A proof-floor getter that reverts.
- A hook that changes the implementation slot.

Each case verifies rollback of implementation, upgrade history, namespace, cached owner and proof
floor. A subsequent valid upgrade confirms that the guard did not remain locked.

A sixth case attempts a nested upgrade from the hook and asserts the exact UpgradeReentered error.
The outer call succeeds, and a subsequent independent upgrade succeeds, testing guard cleanup on
both success and failure.

The nested-call mock deliberately reports immutable owner/time values while corrupting another
storage field. Its success also demonstrates the limits of getter-based post-conditions: they
cannot establish that delegated code actually applied the verified result safely.

## Remaining trust boundaries

- Registered implementations have access to all proxy storage, including the implementation,
  upgrade-history and upgrade-lock slots. They can forge getters, corrupt accounting, bypass the
  intended upgrade entry point, or leave the lock set to prevent subsequent upgrades.
  The guard prevents ordinary nested entry; it cannot sandbox hostile delegated code.
- Post-hook reads check selected reported values, not complete storage integrity, owner revision,
  accounting invariants or arbitrary migration correctness. The current P2IDVault hook performs
  the revision checks itself. Raw owner words are narrowed to 160 bits; the reported proof floor
  is compared as uint256. These are not complete ABI-conformance checks for arbitrary targets.
- Failed, malformed or excessively future-dated *pre-upgrade* floor reads contribute zero by
  design. Recovery from corrupted implementations is not guaranteed: the new hook may still
  reject damaged vault storage.
- Revocation blocks future selection, not code already installed.
- A delayed default change affects future proxy deployments, including funded counterfactual
  addresses. Existing proxies keep their implementation. Default admission checks factory binding,
  not storage layout or initialization behavior.
- Compatibility must be assessed against every source implementation users can upgrade from;
  preserving only the original layout does not establish compatibility with later appended state.

## Comments corrected

The interface now describes post-hook state reads and nested-upgrade rejection. Proxy comments no
longer claim a fallback cannot return the hook selector, that registration audits code, or that
post-conditions catch every incorrect implementation. No contract behavior was changed by this review.

## Validation

Targeted proxy, audit, real-proof, factory and deterministic implementation tests: **47 passing**.
Six audit tests are new in this review. The SDK proxy init-code-hash consistency test passes.

The real-proof benchmark used **4,597,544 gas** for an upgrade versus **4,552,466 gas** for a
standalone proof refresh: 45,078 extra gas, approximately 0.99%. The test also confirms owner/history
synchronization and rollback under insufficient gas. These are local execution-gas measurements.

Full suite: **173 passing** via `yarn test`. `git diff --check` passed. Circuit sources and bundled
proofs were not regenerated.
