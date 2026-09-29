# PviumVerifier review

Date: 2026-09-28.

Scope: `src/PviumVerifier.sol`, `src/interfaces/IP2IDVerifier.sol`, the `PviumIdentity`
integration, and `test/PviumVerifier.test.ts`. This review assesses Solidity logic and its
declared trust boundaries. It is not an independent audit of the Noir circuit, the generated
UltraHonk verifier, Privy's signing infrastructure, or the correctness of a constraint
signer's off-chain decision.

## Result

No unprivileged proof-acceptance bypass, constraint-signature replay across verifier or chain,
or payout-redirection path was identified.

`PviumVerifier` verifies the proof through `PviumIdentity`, compares the resulting identity
commitment with the vault-supplied commitment, rejects a missing EVM wallet, and recomputes the
wallet commitment from that wallet. A constraint signature is recovered from an EIP-712 digest
whose domain contains the chain ID and this verifier address. A registered constraint signer can
therefore authorize a commitment, but cannot select a payout wallet: the wallet always comes from
the accepted identity proof.

## Reviewed controls

- `getIdentityWallet` binds the proof to the caller's expected `identityHash` and the proof's
  wallet hash before returning a wallet.
- Constraint signatures use `PviumVerifier` name/version, chain ID, and verifying-contract
  address in their EIP-712 domain. A signature for another chain or verifier is rejected.
- Signature parsing requires 65 bytes, rejects high-`s` signatures, normalizes `v` from 0/1 to
  27/28, and rejects failed recovery.
- Constraint signers are checked at verification time. Revoking a signer invalidates its
  signatures for future constrained claims.
- `revision()` forwards `PviumIdentity.keySetRevision()`, allowing vaults to invalidate cached
  proof results when identity signing keys are revoked.
- Ownership uses a two-step transfer. Deploying with `owner == address(0)` freezes the initial
  constraint-signer set.

## Trust and availability boundaries

### 1. Constraint signer authority

The verifier does not interpret a nonzero `Constraint.commitment`. It only checks that a current
constraint signer signed it. The owner can add a signer immediately, and any current signer can
authorize a commitment accepted by the verifier.

This cannot redirect a payout because the ZK proof fixes the wallet. It can satisfy a funding
condition earlier or more broadly than a payer expected if the signer or signer-management owner
is compromised. Applications using `screeningCommitment` should include the recipient identity
hash and a unique salt in every commitment. Applications that need the amount, token, deposit ID,
or expiry bound into an authorization must include those values in their own commitment format.

This is an explicit signer and owner trust boundary, not an unprivileged contract vulnerability.

### 2. Signer-set availability

The owner may revoke every constraint signer. Existing constrained deposits then cannot be
claimed through this verifier until a signer is added again; their normal refund path remains
available after its refund window. Deploying with a zero owner makes the initial set permanent,
including an empty set.

This is an availability property of the current administrative model. Deployments that require
constrained claims to remain available need an owner process that maintains at least one trusted
signer or must use a permanent nonempty initial signer set.

### 3. Deployment configuration

The constructor accepts a concrete `PviumIdentity` address without checking that it has code or
that it is the intended identity deployment. A mistaken deployment becomes unusable when proof
verification is attempted; it does not let an external caller forge a result. Deployment tooling
should validate the identity contract address, circuit version, and accepted key set before
registering a verifier in a factory policy.

## Validation

From `contracts/`:

```sh
yarn hardhat test test/PviumVerifier.test.ts
```

Result: **11 passing**. The suite includes a real ZK proof, proof tampering, identity mismatch,
wallet payout binding, signer revocation, EIP-712 chain/verifier separation, malformed signatures,
two-step ownership, and constrained-deposit behavior.
