> Implementation update: the factory now supports owner-only CREATE2 deployment with atomic
> registration proposals and delayed default selection. The immutable-default limitation below
> describes the pre-change factory. Manual registration still has the documented binding gap;
> the new deployment/default paths enforce raw factory binding. See
> `test/VaultImplementationDeployment.test.ts` for regression coverage. This note does not
> constitute an independent audit of arbitrary future implementation bytecode.

# PviumP2IdVaultFactory deployment and maintenance review

Date: 2026-09-29. Scope: current working-tree factory, proxy construction, base-vault initialization,
registry and administrative paths, funding through upgraded vaults, and deployment/verification
scripts. No on-chain deployment was inspected or modified. Factory/proxy execution logic was not
changed by this review.

## Result

The current factory uses PviumP2IDVaultProxy correctly for deployment and initialization. No
unprivileged deployment takeover, administrative bypass or fund-theft path was identified in the
reviewed factory paired with the current P2IDVault implementation and conventional ERC-20 behavior.
One configuration-dependent registration gap remains. Deployment tooling had two maintenance gaps,
which were corrected in this review.

## F1 — Low, configuration-dependent: registry does not check implementation factory binding

Location: src/PviumP2IdVaultFactory.sol, proposeImplementation/registerImplementation.

Proposal checks code presence and existing registration; activation checks owner and delay. Neither
checks the target's immutable factory. The audit test deploys factories A and B with the same default
verifier but different policies, registers B's base implementation in A, then upgrades A's vault
using its owner's valid proof. The hook succeeds. The proxy's factory() still reports A because
that selector is handled by the proxy, while delegated vault.policy() reads B's policy and
fundFor called through A reverts with NotFactory.

This requires an administrator to register the wrong target and the vault owner to select it.
It is not a public registry bypass. The reproduction returns to A's base implementation successfully,
so the configuration error is not inherently permanent. Other combinations of storage and verifier
configuration can have different recovery behavior.

Recommendation: validate the raw implementation's factory() against the registering factory during
registration and in maintenance tooling. Check the raw implementation address, not a vault proxy's
shadowed getter. Retain independent storage-layout and hook review: an arbitrary implementation can
lie through a getter, and code presence plus a matching getter is not a security audit.
This contract-level check remains unimplemented; the new deployment check validates the factory's
own base implementation but does not govern future registry entries.

## F2 — Low, operational: explorer verification used the pre-proxy deployment model — fixed

scripts/verify-deployments.ts previously targeted src/P2IDVault.sol:P2IDVault with no constructor
arguments for VAULTS addresses. These addresses now hold PviumP2IDVaultProxy, and the actual base
P2IDVault requires the factory address as its constructor argument. The base was also absent from
the default verification target list.

The script now targets vault proxies with no arguments and includes the base implementation with
[factory] arguments. For this factory build, its base is the first CREATE from the factory (nonce 1);
tests compare the derived verification target with factory.baseImplementation(). A different
factory creation sequence would require updating that derivation. No explorer submission was made.

## Deployment validation hardening — implemented

checkStack now verifies the expected base address, code presence, embedded factory, registry
membership and both refund-window bounds. It already checked the owner, policy, default verifier,
namespace, policy delay and optional SDK proxy init-code hash. Tests confirm normal validation,
refund-bound mismatches and missing base code. These are wiring checks, not full runtime-bytecode
attestation of arbitrary contracts already present at an address.

## Deployment and maintenance controls verified

- vaultFor uses CREATE2 with this factory, identityHash as salt and the proxy creation-code hash.
  Proxy constructor arguments are empty; its immutable factory is the deploying factory.
- The base is constructed with address(this). Each proxy reads that base from the factory and is
  initialized in the same factory transaction with identityHash, namespace and refund bounds.
  The constructor/getter/initialize sequence exposes no attacker callback in the reviewed code.
- Permissionless deploy does not assign ownership to its caller. Prefunded tokens remain available
  to the identity-proven wallet. Direct initialization of the proxy or base by outsiders reverts.
- deploy is idempotent: it does not reset an existing upgraded proxy or its proof record.
- ERC-20 and native funding work through a compatible upgraded implementation. The caller is stored
  as funder and can refund; conventional ERC-20 funding consumes the temporary factory balance and
  allowance. There is no generic arbitrary-call entry point in the factory.
- Registration requires the factory owner and the 14-day delay. Every administrative entry point
  tested rejects an unrelated account. A pending owner gains no authority until acceptOwnership.
- Ownership handover preserves pending proposals and their original activation times. The old owner
  loses maintenance authority; the new owner must still wait for the recorded deadline.
- Implementation revocation changes registry membership only. It neither rewrites proxy slots nor
  stops installed code, and the base implementation cannot be revoked.

## Maintenance constraints and trust assumptions

The base implementation is immutable. Registering a new version does not change what new proxies
start on, and there is no administrator-driven mass upgrade. Each existing vault needs its owner's
proof-authorized upgrade. If the base contains a future vulnerability, this factory cannot replace
or disable it for newly deployed vaults; that requires a new factory/proxy deployment scheme or a
separate redesign. This is a current design constraint, not a newly demonstrated vulnerability.

The factory owner controls registration, policy and the default verifier after their respective
delays. A replacement default verifier participates in both untracked claims and whole-vault upgrade
authorization. Policy ownership is separate from factory ownership and can change its allowlist
without changing the factory's policy address. A zero policyChangeDelay is accepted at construction;
the 7-day value used by deployment defaults is not an enforced minimum.

Registered implementations have full proxy storage access. They must preserve the identity and
accounting layout, enforce fundFor's factory authorization and handle the owner-proof hook correctly.
The factory has no funding reentrancy guard or post-call check that an arbitrary upgraded fundFor
consumed its ERC-20 approval. The current implementation consumes the approved amount, as tested;
future partial-pull or callback-heavy implementations need a separate shared-factory funding review.
Arbitrary token balance/transfer behavior is outside the conventional-token result above.

## Changes and validation

Added six factory audit tests and one deployment-validation test. Corrected explorer targets,
expanded checkStack, and updated proxy deployment/maintenance documentation in contracts/README.md
and DEPLOYMENT.md. No Solidity execution changes, circuit rebuild or generated verifier edits.

Run from contracts/ with the prescribed Node PATH:

```sh
yarn hardhat test
```

Result: **157 passing**. `git diff --check` also passed. Explorer target construction was tested
locally; actual explorer verification and live-chain deployment checks were not run.
