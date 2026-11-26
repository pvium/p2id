# Alpha proof acceptance

The factory tracks alpha by verification-key SHA-256: `isAlpha(vkHash)` and
owner-only `setAlpha(vkHash, enabled)`. The initial default verifier's key starts in
alpha. Enable alpha for each new circuit key before approving its verifier for use;
disable it once that build is accepted for ordinary proof verification. Other keys
retain their own status. Enabling alpha invalidates ownership cached under that key,
including caches at other verifier addresses sharing the same key.

The Solidity proof encoding is `abi.encode(zkProof, publicInputs)`: it contains no
key hash. `PviumIdentity` pins the key-artifact SHA-256 at deployment, and
`PviumVerifier.vkHash()` exposes it. Deployment reads `circuit/version.json` and
records the hash for verification. This binding is trusted deployment configuration;
the constructor does not compute the hash from the verifier's bytecode. Never use
caller-provided proof JSON metadata to select alpha status. A verifier key change
invalidates its owner caches too.

`P2IDVault` requires alpha attestation only on `refreshProof`,
`refreshProofAndSweep`, `sweepBucket` and `sweepBucketDeposits` when the selected
verifier's key is in alpha. The proxy applies the same rule to `upgradeTo`, using
the factory's default verifier. The generic wrapper accepts only those four business
proof methods. Proofless `sweep`, `sweepDeposits` and `sweepUntracked` use a
current, verified owner cache without a new signature. `withdrawFees` verifies no
identity proof and needs no alpha attestation. Funding, refunds and direct transfers
remain available. Funding-constraint signatures remain separate and mandatory for
constrained claims in both modes.

The factory keeps one alpha attester, configured by `ALPHA_ATTESTER_SANDBOX` /
`ALPHA_ATTESTER_PROD`, falling back to the factory owner. `ATTESTER_*` separately
configures the verifier's constraint signer. The owner can immediately rotate the
alpha signer via `setDefaultAttester`. Every alpha toggle or signer change increments
`alphaEpoch` to invalidate outstanding signed authorizations.

## Signing and submitting

Use the named entry points while alpha is enabled:

| Ordinary method (after alpha) | Signed method (during alpha) |
| --- | --- |
| `refreshProof` | `refreshProofWithAttestation` |
| `refreshProofAndSweep` | `refreshProofAndSweepWithAttestation` |
| `sweepBucket` | `sweepBucketWithAttestation` |
| `sweepBucketDeposits` | `sweepBucketDepositsWithAttestation` |
| `upgradeTo` | `upgradeToWithAttestation` |

Ordinary proof-verifying methods call their `WithAttestation` counterparts internally with nonce and deadline zero
and an empty signature. `alphaAttestationRequired` rejects empty signatures and verifies
the complete call when alpha is enabled; after alpha it skips attestation verification.

Each signed method takes the ordinary method's arguments followed by one
`AlphaAttestation { nonce, deadline, signature }` struct (an ABI tuple), and returns
the ordinary method's result. After alpha, call the ordinary
method with its original arguments; no nonce, empty signature or deadline is needed. The
generic `executeWithAttestation` wrapper remains available, and all signed entry points
share its authorization and execution logic.

Encode the intended existing method with all its arguments, including the proof, deposit
IDs, token, original funding commitment and funding-constraint evidence when applicable:

```typescript
const action = vault.interface.encodeFunctionData('refreshProofAndSweep', [
  verifier, proof, token, depositCountLimit,
]);
const domain = {
  name: 'PviumAlpha', version: '1', chainId,
  verifyingContract: factoryAddress,
};
const types = { AlphaAuthorization: [
  { name: 'vault', type: 'address' },
  { name: 'caller', type: 'address' },
  { name: 'callHash', type: 'bytes32' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
  { name: 'epoch', type: 'uint256' },
] };
const nonce = BigInt(ethers.hexlify(ethers.randomBytes(32)));
const authorization = {
  vault: vaultAddress, caller: transactionSender,
  callHash: ethers.keccak256(action),
  nonce, deadline,
  epoch: await factory.alphaEpoch(),
};
const signature = await attester.signTypedData(domain, types, authorization);
await vault.refreshProofAndSweepWithAttestation(
  verifier, proof, token, depositCountLimit, { nonce, deadline, signature },
);
// Once the admin disables alpha:
await vault.sweep(verifier, token, depositCountLimit);
```

Sign the **ordinary method's calldata**, as shown above, rather than the signed wrapper's
calldata. The named wrapper constructs that exact ordinary call internally. This avoids
including the signature in the data being signed.

The contract reconstructs the exact call hash and validates a canonical low-s ECDSA
signature from `defaultAttester`. Nonces are caller-supplied random 256-bit values; no nonce RPC read or
sequence is required. Each vault records consumed business nonces, rejects reuse across
business methods, and rolls consumption back on failure. The signature is bound to the caller, vault, factory, chain, epoch and
expiry. A relayer must be explicitly signed as `caller`. Upgrades still require the
original caller to be the proof's wallet. The wrapper accepts no native value. Business
methods use the `P2IDVault` or `IP2IDVault` ABI at the proxy address. Both modes share one
business interface. Upgrades use
the proxy ABI with the same caller-supplied nonce pattern and an independent used-nonce
set; their
signed call hash is still the ordinary `upgradeTo` calldata. Business wrappers do not
accept upgrade actions.

For proofless sweeps, the backend must independently authenticate the cached recipient;
it must not treat an existing owner cache as sufficient evidence. Cursor-based sweeps
authorize the selected page at execution time, and untracked sweeps authorize the entire
then-current surplus, including funds received after signing. Use explicit deposit IDs
for exact recorded-deposit scope and short expiries for surplus sweeps.

## Required backend policy

**Never sign arbitrary client calldata or authorize solely by verifying its ZK proof.**
Verify the Privy JWT with conventional ES256 verification against trusted keys and check
that the identity and intended recipient are linked in that authenticated token. Validate
the vault's identity, selected verifier, proof's public wallet and issue time, every
funding constraint and selected deposit, and the requested withdrawal scope against that
independent evidence. Validate upgrades against the intended wallet and reviewed target.
The call hash binds those reviewed arguments; it does not itself authenticate their
meaning. Sign only supported verifier encodings and narrowly scoped actions. This
repository implements the contract guard; the backend signer and client submission flow
must be integrated before launch. Expiry/freshness policy for the JWT is the backend's
responsibility.

The factory's implementation registry remains a trusted code allowlist. Register only
implementations whose proof acceptance and ownership cache APIs enforce these checks. An implementation
adding a proof-verifying method must guard it and invalidate stale caches. Upgrade targets must return true from `supportsAlphaGuard()`
even when alpha is off, so the protection can be re-enabled. This marker is a code
compatibility claim, not a security audit. Registered code can
write proxy storage; the authorization layer cannot make malicious registered code safe.

## Deployment and storage

This stack is pre-launch. `P2IDVault.sol` is the single source of truth for both alpha and
post-alpha operation, preserving the original layout and appending authorization state.
There is no separate alpha implementation. Regression tests compare ordinary code and ABI
against the pre-alpha business-body hashes and ABI fixture, while exercising ordinary behavior with alpha off.
Future implementations must preserve the original snapshot and the current vault layout;
`CANDIDATE=<Contract> yarn layout` checks both. After production release, deployed sources
are frozen and later behavior changes require a new implementation. The proxy keeps only
upgrade management and a namespaced set of used upgrade nonces; its
fallback does not inspect or intercept sweep/proof selectors. The ABI-boundary regression
test prevents business methods being added back to the proxy. Deployment records identify
the base implementation source for explorer verification, retaining the legacy source for
old records. The proxy creation-code hash and deterministic factory address change: existing
sandbox proxies **do not gain this guard**. Refresh SDK constants and deploy a fresh
sandbox stack; clear the stale sandbox factory until deployment records the new one.
Once a production scheme exists, proxy changes require a new address scheme. Historical
deployment records should remain available to locate old deposits.

Before disabling alpha, separately confirm that the deployed verifier versions are
safe and plan for historical deposits pinned to older verifier addresses. Disabling the
flag does not replace a verifier or migrate deposits.
