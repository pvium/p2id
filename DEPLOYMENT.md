# Set up P2ID payments

You can use Pvium's reference deployment or deploy your own P2ID contracts. Both support
payments that name a verifier with `fundWith`; the difference is who controls verifier
approval and which vault addresses your application uses.

Deploying your own factory at a different address creates a new set of deterministic vault
addresses for the same identities, comparable to operating in a separate payment namespace.
Payers must derive addresses for the chosen deployment; funds sent to Pvium's vaults and
funds sent to your vaults belong to separate contracts.

| | Use Pvium's deployment | Deploy your own setup |
| --- | --- | --- |
| Factory and vaults | Use the existing Pvium factory and its identity vaults | Deploy a factory that creates your identity vaults |
| Policy | Managed by Pvium | Managed by you |
| Your own verifier | Contact Pvium to register it before accepting payments through it | Approve it through your policy |
| Vault addresses | Pvium's addresses for the selected environment | Different addresses when your factory address differs |

A policy is attached to a factory and controls verifier approval and fee quotes for that
factory's vaults. One policy can approve multiple verifiers. A verifier authenticates
proofs; it does not choose the factory's policy.

## Option 1: Use Pvium's reference deployment

Use the factory deployed on your target chain. The core SDK derives addresses for Pvium's
production deployment by default; select `environment: 'sandbox'` for its testnet deployment.
Confirm the factory exists on the chain before sending funds.

You can use Pvium's reference verifier and its Privy-based proof system, or implement your
own verifier using the interface below. To use your own verifier, deploy it and contact
Pvium to register its address on each supported chain. Provide its source code, proof
format, and trusted identity sources for review. The current policy permits only its owner
to approve verifiers; deployment alone does not register one.

Once your verifier is approved, use its address in the `fundWith` example below. This
uses the existing identity vault address and records your verifier for that deposit.

If you need to host Pvium's prover yourself, follow
[http-prover/README.md](http-prover/README.md). Its output is for Pvium's reference verifier;
a different verifier may need its own proof-generation service.

## Option 2: Deploy your own setup

Deploy your own verifier, policy, and factory when you want to control verifier admission
and operate a separate set of identity vaults. You can reuse the reference Solidity
contracts or implement the interfaces in [P2ID.md](P2ID.md).

With the reference contracts, the setup order is:

1. Deploy a verifier implementing `IP2IDVerifier`. Set up the proof-generation tooling
   that recipients will use with it.
2. Deploy `PviumP2IDPolicy(owner, [verifier])`. This policy approves the supplied verifier
   addresses and quotes zero fees. Its owner can later add or remove verifiers with
   `approveVerifier(verifier, true/false)`. A custom policy implements
   [IP2IDPolicy](contracts/src/interfaces/IP2IDPolicy.sol) and defines its own admission
   and fee rules.
3. Deploy `PviumP2IdVaultFactory` with your owner, namespace hash, policy, initial verifier,
   policy-change delay, refund-window bounds, and alpha signer. The initial verifier must
   already be approved by the policy and report a nonzero `vkHash()`. The factory deploys
   the starting vault implementation itself; individual identity vaults are created as needed.
4. From the reference policy's owner account, call `policy.setFactory(factoryAddress)`
   to bind it to your factory. Confirm `factory.policy()` and `policy.factory()` point
   to the intended contracts.
5. Publish your chain IDs, factory and verifier addresses, vault creation-code hash, and
   proof instructions. Configure payers and recipients to use those values.

See the [factory constructor](contracts/src/PviumP2IdVaultFactory.sol) for the exact argument
order and limits. Policy-change delays must be 1–30 days; refund-window bounds must be
between 1 hour and 365 days, with the minimum no greater than the maximum. These are
requirements of the reference implementation.

The repository's `deploy-deterministic.ts` script is configured for Pvium's own deployment
and recorded addresses. For an independent setup, write a deployment script for your chosen
contracts and configuration rather than replacing Pvium's SDK records. Run your script with
`yarn hardhat run scripts/<your-script>.ts --network <network>` from your Hardhat project.

### Derive addresses for your factory

Changing the factory address changes the vault address for the same identity. Reusing
Pvium's hashing rules does not make your vaults share Pvium's addresses. Funds already sent
to one deployment remain there; a new deployment does not move them.

Read `factory.vaultFor(identityHash)` to obtain your deployment's vault address. For local
calculation, the protocol uses both your factory address and its vault creation-code hash.
If you reuse the exact proxy bytecode bundled with the core SDK, you can override the factory:

```ts
import { IdentityType, p2idAddress } from '@pvium/p2id-core';

const vaultAddress = p2idAddress({
  identityType: IdentityType.Email,
  identityValue: 'you@example.com',
  factory: yourFactoryAddress,
});
```

Check that `factory.initCodeHash()` matches the selected SDK scheme's `vaultInitCodeHash`
and that the result equals `factory.vaultFor(identityHash)`. If your proxy bytecode differs,
use your actual creation-code hash with the [protocol address formula](P2ID.md#vault-address)
or obtain the address directly from your factory.

## Implement a verifier

Implement [IP2IDVerifier](contracts/src/interfaces/IP2IDVerifier.sol) and follow the
[protocol's verification requirements](P2ID.md#verification-and-claims):

| Method | Required behavior |
| --- | --- |
| `getIdentityWallet(identityHash, proof, constraint)` | Authenticate the supplied identity commitment and its linked wallet. Return a nonzero wallet and the attestation issue time in Unix seconds. Revert for an invalid proof, a different identity, or an unsatisfied nonzero constraint |
| `supportsConstraints()` | Return whether the verifier supports nonzero funding constraints |
| `revision()` | Change the revision when previously accepted identity proofs may no longer be trusted, so vaults invalidate cached wallets. A constant is appropriate only when trust cannot be revoked |
| `vkHash()` | Return the verifier's pinned verification-key artifact SHA-256, read from trusted verifier configuration rather than caller-supplied proof metadata |

Use the identity normalization and commitment formula in [P2ID.md](P2ID.md#identity-commitments).
Your proof must authenticate both that commitment and the returned wallet. The wallet must
come from verified evidence; accepting an arbitrary payout address would let a caller claim
someone else's funds.

The `proof` argument is opaque bytes. Define and document your encoding, proof-generation
procedure, trusted sources, and revocation behavior. The standard does not require Privy
or Pvium's proof format. [PviumVerifier.sol](contracts/src/PviumVerifier.sol) is one example:
it decodes a zero-knowledge proof and public inputs, verifies them through `PviumIdentity`,
and checks the identity and wallet commitments.

If constraints are unsupported, return false from `supportsConstraints()` and reject nonzero
commitments. If supported, validate the commitment and its evidence before returning a wallet.

## Confirm your verifier is ready for payments

On each target chain, confirm the verifier has deployed code and that the factory's current
policy returns true from `isVerifierAllowed(verifier)`. On Pvium's deployment, contact Pvium
if approval is missing. On your own deployment with the reference policy, its owner calls
`approveVerifier(verifier, true)`.

Each recorded deposit keeps the verifier selected at funding. Selecting a different
verifier does not change the identity's vault address.

## Fund a payment with your verifier

Use your selected factory's `fundWith` method. It deploys the identity vault if necessary
and records the caller as the funder:

```solidity
function fundWith(
    bytes32 identityHash,
    address verifier,
    address token,
    uint256 amount,
    bytes32 constraint,
    uint64 refundWindow,
    bytes32 ref
) external payable returns (address vault, uint256 depositId);
```

For an ERC-20 payment, approve the factory to spend the amount before calling `fundWith`.
The following ethers v6 example uses addresses supplied by your application:

```ts
import { Contract, ZeroHash } from 'ethers';
import { IdentityType, identityHash } from '@pvium/p2id-core';

// signer is the payer's ethers Signer on the target chain.
// factoryAddress, verifierAddress, and tokenAddress are deployed on that chain.
const factory = new Contract(factoryAddress, [
  'function minRefundWindow() view returns (uint64)',
  'function fundWith(bytes32 identityHash, address verifier, address token, uint256 amount, bytes32 constraint, uint64 refundWindow, bytes32 ref) payable returns (address vault, uint256 depositId)',
], signer);
const token = new Contract(tokenAddress, [
  'function approve(address spender, uint256 amount) returns (bool)',
], signer);

const recipient = identityHash(IdentityType.Email, 'you@example.com');
const amount = 1_000_000n; // One token if this ERC-20 uses six decimals.
const refundWindow = await factory.minRefundWindow();

await (await token.approve(factoryAddress, amount)).wait();
const receipt = await (await factory.fundWith(
  recipient,
  verifierAddress,
  tokenAddress,
  amount,
  ZeroHash,      // No additional claim constraint.
  refundWindow, // Seconds; must be within the factory's current bounds.
  ZeroHash,      // No application reference.
)).wait();
```

Read the vault's `Funded` event from the receipt to obtain the deposit ID and credited
amount. A transaction receipt does not expose the Solidity return values. With a
fee-on-transfer token, the credited amount can be less than the requested amount.

For native currency, pass `ZeroAddress` as the token and send the same amount as transaction
value. With the factory and recipient from the example above:

```ts
import { ZeroAddress, parseEther } from 'ethers';

const nativeAmount = parseEther('0.001');
await (await factory.fundWith(
  recipient, verifierAddress, ZeroAddress, nativeAmount,
  ZeroHash, refundWindow, ZeroHash,
  { value: nativeAmount },
)).wait();
```

An ERC-20 call must send no native value. `ref` is an optional application reference emitted
in the funding event; it does not affect eligibility or the payout wallet.

A direct transfer to the vault does not select your verifier or create a refundable deposit.
Use `fundWith` when the payment must be claimed through your verifier.

## Claim and test the payment

The recipient generates a proof in your verifier's format. For an unconstrained deposit,
present it to the vault with `refreshProofAndSweep(verifier, proof, token, depositCountLimit)`.
For a constrained deposit, use `sweepBucket` or `sweepBucketDeposits` with the matching
constraint and evidence. See [IP2IDVault](contracts/src/interfaces/IP2IDVault.sol) for the
method signatures. The vault pays the authenticated wallet returned by your verifier.

Before accepting real payments, test a successful claim, an invalid proof, an identity
mismatch, and an attempt to substitute the payout wallet. Test stale proofs and revision
changes, and constraint rejection if applicable. For a separate unclaimed deposit, confirm
that the original funder can call `refund(depositId)` after its refund window. Refunds remain
available even if the policy stops approving the verifier.

### Alpha testing with the Pvium reference implementation

Alpha authorization is an extension of Pvium's reference implementation, separate from the
standard verifier interface. It can provide an additional signed approval during alpha testing.

On that implementation, new key hashes require alpha authorization until released by the
factory owner. Read `factory.isAlpha(verifier.vkHash())` before testing claims. While enabled,
use the corresponding `*WithAttestation` claim method with an authorization from the factory's
configured alpha signer. The authorization binds the vault, caller, action, nonce, deadline,
and factory epoch; it does not replace the identity proof or policy approval.

For Pvium's deployment, coordinate with Pvium for testing authorizations or release of the
verifier's key hash. For your own deployment using these contracts, configure an alpha signer
and issue test authorizations; when ready, the factory owner can call `setAlpha(vkHash, false)`. Funding a deposit through `fundWith` does not itself require an alpha authorization.
