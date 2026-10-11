# @pvium/p2id-core

Derive deterministic EVM vault addresses from email addresses, social handles and other supported
identities. Addresses can receive funds before the recipient registers or the vault is deployed.
Claims pay the wallet bound by an accepted identity proof.

Use Pvium’s reference deployment or your own factory. A different factory address creates
a separate set of deterministic vault addresses for the same identities, comparable to
a different payment namespace. The SDK defaults to Pvium’s production factory.

Learn more about P2ID in the [P2ID protocol specification](https://github.com/pvium/zkid/blob/main/P2ID.md).

The package includes identity hashing, address derivation and Solidity sources. For off-chain
proof verification, use
[`@pvium/p2id-verifier`](https://www.npmjs.com/package/@pvium/p2id-verifier).

## Install

```sh
yarn add @pvium/p2id-core
```

Requires Node.js 20+ or a browser with support for ES modules and `TextEncoder`.

## Quick start

```ts
import { p2idAddress, IdentityType } from '@pvium/p2id-core';

const to = p2idAddress({
  identityType: IdentityType.Email,
  identityValue: 'you@example.com',
});
// Checksummed vault address for native coin or supported ERC-20 transfers.
```

Transfer funds to the derived address on a chain with the matching factory deployment.
Email addresses are case-insensitive: `You@Example.com` derives the same address.

Production is the default environment. Use `sandbox` on testnets or pass a custom factory address:

```ts
p2idAddress({
  identityType: IdentityType.X,
  identityValue: 'jack',
  environment: 'sandbox',
});
p2idAddress({
  identityType: IdentityType.Github,
  identityValue: 'octocat',
  factory: yourFactoryAddress, // Your deployed factory address, typed as `0x${string}`.
});
```

The SDK includes factory addresses for Pvium's environments; an explicit `factory` overrides
that address. It still uses the selected scheme's vault creation-code hash. For your own
factory, confirm `factory.initCodeHash()` matches `p2idScheme().vaultInitCodeHash` and compare
the result with `factory.vaultFor(identityHash)`. If your proxy bytecode differs, use your
actual creation-code hash with the protocol formula or read the address from the factory.
Address derivation does not check on-chain deployment or whether a recipient can produce a proof.

## Pay an identity

Using [ethers](https://docs.ethers.org) v6:

```ts
import { ethers } from 'ethers';
import { p2idAddress, IdentityType } from '@pvium/p2id-core';

const signer = new ethers.Wallet(
  process.env.PRIVATE_KEY!,
  new ethers.JsonRpcProvider(process.env.RPC_URL),
);
const to = p2idAddress({
  identityType: IdentityType.Telegram,
  identityValue: 'durov',
});

// the native coin (BNB on BNB Chain, ETH on Base)
await (await signer.sendTransaction({ to, value: ethers.parseEther('0.1') })).wait();

// an ERC-20
const USDC = '0x…'; // the token's contract address on the chain you are paying on
const usdc = new ethers.Contract(
  USDC,
  ['function transfer(address to, uint256 amount) returns (bool)'],
  signer,
);
await (await usdc.transfer(to, 25_000_000n)).wait(); // 25 USDC (6 decimals)
```

Direct transfers have no refund path. Funds can be claimed after vault deployment and identity
verification.

### Refundable deposits

Use `factory.fund` to record a deposit with a refund window. The funder can refund an unclaimed
deposit after that window elapses.

```ts
import { ethers } from 'ethers';
import { identityHash, p2idScheme, IdentityType } from '@pvium/p2id-core';

const signer = new ethers.Wallet(
  process.env.PRIVATE_KEY!,
  new ethers.JsonRpcProvider(process.env.RPC_URL),
);
const factory = new ethers.Contract(
  p2idScheme().factories.production!, // or .sandbox on testnets
  [
    'function fund(bytes32 identityHash, address token, uint256 amount, bytes32 constraint, uint64 refundWindow, bytes32 ref) payable returns (address vault, uint256 depositId)',
    'function fundWith(bytes32 identityHash, address verifier, address token, uint256 amount, bytes32 constraint, uint64 refundWindow, bytes32 ref) payable returns (address vault, uint256 depositId)',
  ],
  signer,
);

const id = identityHash(IdentityType.Email, 'you@example.com');
const NO_CONSTRAINT = ethers.ZeroHash; // no additional claim requirement
const WEEK = 7 * 24 * 3600; // refund window in seconds
const ref = ethers.id('invoice-42'); // application-defined bytes32; ethers.ZeroHash for none

// Native coin: use the zero address for `token` and send `amount` as transaction value.
const amount = ethers.parseEther('0.1');
await (await factory.fund(id, ethers.ZeroAddress, amount, NO_CONSTRAINT, WEEK, ref, {
  value: amount,
})).wait();

// an ERC-20: approve the factory, then fund
const USDC = '0x…'; // the token's contract address
const usdc = new ethers.Contract(
  USDC,
  ['function approve(address spender, uint256 amount) returns (bool)'],
  signer,
);
await (await usdc.approve(await factory.getAddress(), 25_000_000n)).wait();
const receipt = await (await factory.fund(id, USDC, 25_000_000n, NO_CONSTRAINT, WEEK, ref)).wait();
```

`fund` records the factory's default verifier for the deposit. Read the vault's `Funded`
event from the transaction receipt to obtain the deposit ID and credited amount; sending
a transaction does not return the Solidity function's return values. Fee-on-transfer tokens
may credit less than the requested amount.

`fund` accepts the same arguments for native coin and ERC-20 deposits:

| Argument       | Meaning                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `identityHash` | Recipient commitment from `identityHash(type, value)`                     |
| `token`        | ERC-20 contract address, or the zero address for native coin              |
| `amount`       | Amount in the asset's smallest unit                                       |
| `constraint`   | A 32-byte commitment to an additional claim requirement; zero for none    |
| `refundWindow` | Seconds before an unclaimed deposit becomes refundable                    |
| `ref`          | Application-defined 32-byte reference, emitted in `Funded`; zero for none |

The window must fall within the factory's configured limits. After it elapses, the funder calls
`refund(depositId)` on the vault. Contract interfaces are included; see [Solidity](#solidity).

`ref` is event-only metadata, not a claim constraint or an idempotency key. Repeated references
are allowed. Match a `Funded` event to an application record using its reference and identify
the deposit by chain, vault address and `depositId`. The contract does not store the reference
or interpret its contents. The `memo` URI parameter remains application text, not an onchain
funding argument.

### Choose a verifier for a deposit

Use `fundWith` to select an approved verifier for that payment. With the ERC-20 approval
and factory from the example above:

```ts
const receipt = await (await factory.fundWith(
  id, verifierAddress, USDC, 25_000_000n, NO_CONSTRAINT, WEEK, ref,
)).wait();
```

For native currency, pass `ethers.ZeroAddress` for the token and provide `{ value: amount }`.
The selected verifier is stored with the deposit and does not change the vault address.

When using Pvium's reference factory, contact Pvium to register your verifier before
accepting payments through it. If you operate your own factory and policy, you control
verifier approval. See the [setup guide](https://github.com/pvium/zkid/blob/main/DEPLOYMENT.md)
for verifier requirements and both deployment options.

## Read balances

Read native coin and ERC-20 balances at the derived address:

```ts
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
await provider.getBalance(to); // native coin

const token = new ethers.Contract(
  USDC,
  ['function balanceOf(address) view returns (uint256)'],
  provider,
);
await token.balanceOf(to); // ERC-20
```

## Identity types

Identity parameters accept an `IdentityType` enum value or a P2ID type name such as `'email'`,
`'x'` or `'github'` (`'twitter'` is accepted as an alias of `'x'`). P2ID core is agnostic of any
identity provider: it does not accept provider-specific account types (e.g. Privy's
`'twitter_oauth'`) — callers map those to P2ID names themselves. `resolveIdentityType` converts
these to the numeric IDs used in identity hashes, and `identityTypeName` gives the P2ID name of an
ID. The type table is append-only.

| `IdentityType.`       |  Id | Value            | Example                 | Lowercased |
| --------------------- | --: | ---------------- | ----------------------- | :--------: |
| `Email`               |   0 | address          | `you@example.com`       |    yes     |
| `Phone`               |   1 | E.164 number     | `+15551234567`          |     no     |
| `Google` (deprecated)              |   2 | email            | `you@gmail.com`         |    yes     |
| `X` (alias `Twitter`) |   3 | username, no `@` | `jack`                  |    yes     |
| `Discord`             |   4 | username + discriminator | `wumpus#0`       |    yes     |
| `Github`              |   5 | username         | `octocat`               |    yes     |
| `Linkedin` (deprecated)            |   6 | email            | `you@example.com`       |    yes     |
| `Apple` (deprecated)               |   7 | email            | `you@icloud.com`        |    yes     |
| `Telegram`            |   8 | username         | `durov`                 |    yes     |
| `Tiktok`              |   9 | username         | `charlidamelio`         |    yes     |
| `Instagram`           |  10 | username         | `instagram`             |    yes     |
| `Farcaster`           |  11 | username         | `dwr`                   |    yes     |
| `Wallet`              |  12 | address          | `0xA01b…0f98` or base58 | only `0x…` |

`Google` (2), `Linkedin` (6), and `Apple` (7) are deprecated. `identityHash`, `p2idAddress`,
and `resolveIdentityType` reject their enum values and string names with an error directing
you to `Email` / `'email'`. Authentication providers belong to the verifier's configuration,
not separate email namespaces. Use `isDeprecatedIdentityType(type)` to inspect the deprecation
flag; the enum values and name mappings remain available to identify legacy IDs.

Do not replace the type of an existing commitment with `email`: the hash and vault address
will differ. `p2idAddressForHash` can still derive an address from an existing commitment.

Rejecting previously accepted types is a breaking SDK change and requires a major release.
No automatic conversion of deprecated types is performed.

For Discord, use the username with its discriminator: `wumpus#0` for a migrated username
or `wumpus#1234` for a legacy one. The SDK appends `#0` when no discriminator is supplied.

Normalization lowercases ASCII letters for the types shown above. It does not trim whitespace
or perform Unicode case folding. Values must contain 1–128 UTF-8 bytes after completion.

Handle reassignment can allow a new holder to claim remaining funds.

## Address derivation

```
identityHash = sha256( "p2id.identity.v1" ‖ byte(typeId) ‖ normalize(value) )
p2id         = keccak256( 0xff ‖ factory ‖ identityHash ‖ vaultInitCodeHash )[12..]
```

```ts
import {
  identityHash,
  p2idAddressForHash,
  p2idScheme,
  P2ID_SCHEME,
  IdentityType,
} from '@pvium/p2id-core';

const hash = identityHash(IdentityType.Email, 'you@example.com'); // identity commitment and vault salt
p2idAddressForHash(hash, { environment: 'sandbox' }); // same result as p2idAddress(...)

P2ID_SCHEME; // 'pvium.vault.v1', the current address scheme
p2idScheme(); // { identityDomain, vaultInitCodeHash, factories: { production, sandbox } }
```

The formula excludes the chain ID. Addresses match across chains with standard CREATE2 semantics
when the factory address and vault creation bytecode match. `production` and `sandbox` use
separate factories.

An address scheme fixes the identity domain, factory addresses and vault creation-code hash.
A different factory address or vault proxy creation-code hash changes the derived addresses.
A compatible vault implementation upgrade behind the same proxy leaves addresses unchanged.
Pvium records a new address scheme when releasing a different factory/proxy deployment. To derive an address under a previous
scheme, pass its name, for example `scheme: 'pvium.vault.v1'`.
See [P2ID.md](https://github.com/pvium/zkid/blob/main/P2ID.md) for the protocol specification.

## Solidity

The package includes Solidity interfaces and contract sources for on-chain identity verification.
Compute `identityHash` off chain and pass it to `verifyIdentity` to keep the raw identity
value out of the call's arguments:

```solidity
import {IPviumIdentity} from "@pvium/p2id-core/contracts/interfaces/IPviumIdentity.sol";
import {P2IDHash} from "@pvium/p2id-core/contracts/lib/P2IDHash.sol";

contract PayByEmail {
    IPviumIdentity public immutable pvium;

    constructor(IPviumIdentity _pvium) {
        pvium = _pvium;
    }

    /// @param identityHash identityHash(IdentityType.Email, "you@example.com") from the SDK
    function pay(bytes calldata proof, bytes32[] calldata inputs, bytes32 identityHash, address payable wallet) external payable {
        uint64 issuedAt = pvium.verifyIdentity(proof, inputs, 0 /* IdentityType.Email */, identityHash, P2IDHash.walletHash(wallet));
        require(block.timestamp - issuedAt < 30 days, "attestation too old");
        (bool ok, ) = wallet.call{value: msg.value}("");
        require(ok, "payment failed");
    }
}
```

For a base64-encoded attestation proof:

```ts
const hash = identityHash(IdentityType.Email, 'you@example.com');
const proof = ethers.decodeBase64(attestation.proof);
await payByEmail.pay(proof, publicInputFields, hash, attestation.wallet, {
  value,
});
```

`verifyIdentity` checks the identity type, identity hash and wallet hash against the proof.
It reverts on failure and returns the attestation's issue time on success. Computing the wallet
hash on chain binds the payout address to the proof. Verification costs approximately 4.4M gas
with the current circuit.

`P2IDHash.walletHash(string)` can hash a non-EVM wallet identifier, such as a base58 Solana
address, for proof verification. The EVM payment example above requires an EVM payout wallet;
hashing a non-EVM identifier does not enable an EVM vault to transfer assets to that chain.

## Exports

| Export                                                                             | Purpose                                                                                        |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `p2idAddress(input)`                                                               | Derive a vault address from `{ identityType, identityValue, environment?, scheme?, factory? }` |
| `p2idAddressForHash(hash, opts?)`                                                  | Derive a vault address from an identity hash                                                   |
| `identityHash(type, value, scheme?)`                                               | Compute the identity commitment used as the vault salt                                         |
| `P2ID_SCHEME`, `P2ID_SCHEMES`, `p2idScheme(name?)`                                 | Read address-scheme constants                                                                  |
| `IdentityType`, `IdentityTypeName`, `IDENTITY_TYPE_BY_NAME`, `resolveIdentityType` | Identity type IDs and name mappings (including reserved deprecated types)                                                            |
| `isDeprecatedIdentityType(type)` | Check whether a type is deprecated for new identity generation |
| `completeIdentityValue`, `normalizeIdentityValue`, `isCaseInsensitive`, `HASH_PREFIX`                       | Identity normalisation rules and hash prefix                                                   |
| `checksumAddress`, `toHex`                                                         | Address checksum and hexadecimal encoding                                                      |
