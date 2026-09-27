# @pvium/p2id-core

Derive deterministic EVM vault addresses from email addresses, social handles and other supported
identities. Addresses can receive funds before the recipient registers or the vault is deployed.
Claims pay the wallet bound by an accepted identity proof.

The package includes identity hashing, address derivation and Solidity sources. For off-chain
proof verification, use
[`@pvium/p2id-verifier`](https://www.npmjs.com/package/@pvium/p2id-verifier).

## Install

```sh
yarn add @pvium/p2id-core
```

Requires Node.js 20+ or a browser with Web Crypto support.

## Quick start

```ts
import { p2idAddress, IdentityType } from '@pvium/p2id-core';

const to = p2idAddress({ identityType: IdentityType.Email, identityValue: 'you@example.com' });
// Checksummed vault address for native coin or supported ERC-20 transfers.
```

Transfer funds to the derived address on a chain with the matching factory deployment.
Email addresses are case-insensitive: `You@Example.com` derives the same address.

Production is the default environment. Use `sandbox` on testnets or pass a custom factory address:

```ts
p2idAddress({ identityType: IdentityType.X, identityValue: 'jack', environment: 'sandbox' });
p2idAddress({ identityType: IdentityType.Github, identityValue: 'octocat', factory: '0xYourFactory…' });
```

Derivation requires a recorded factory for the selected environment or an explicit `factory`.

## Pay an identity

Using [ethers](https://docs.ethers.org) v6:

```ts
import { ethers } from 'ethers';
import { p2idAddress, IdentityType } from '@pvium/p2id-core';

const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, new ethers.JsonRpcProvider(process.env.RPC_URL));
const to = p2idAddress({ identityType: IdentityType.Telegram, identityValue: 'durov' });

// the native coin (BNB on BNB Chain, ETH on Base)
await signer.sendTransaction({ to, value: ethers.parseEther('0.1') });

// an ERC-20
const USDC = '0x…'; // the token's contract address on the chain you are paying on
const usdc = new ethers.Contract(USDC, ['function transfer(address to, uint256 amount) returns (bool)'], signer);
await usdc.transfer(to, 25_000_000n); // 25 USDC (6 decimals)
```

Direct transfers have no refund path. Funds can be claimed after vault deployment and identity
verification.

### Refundable deposits

Use `factory.fund` to record a deposit with a refund window. The funder can refund an unclaimed
deposit after that window elapses.

```ts
import { ethers } from 'ethers';
import { identityHash, p2idScheme, IdentityType } from '@pvium/p2id-core';

const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, new ethers.JsonRpcProvider(process.env.RPC_URL));
const factory = new ethers.Contract(
  p2idScheme().factories.production!, // or .sandbox on testnets
  ['function fund(bytes32 identityHash, address token, uint256 amount, bytes32 constraint, uint64 refundWindow, bytes32 ref) payable returns (address vault, uint256 depositId)'],
  signer,
);

const id = identityHash(IdentityType.Email, 'you@example.com');
const NO_CONSTRAINT = ethers.ZeroHash; // no additional claim requirement
const WEEK = 7 * 24 * 3600;            // refund window in seconds
const ref = ethers.id('invoice-42');  // application-defined bytes32; ethers.ZeroHash for none

// Native coin: use the zero address for `token` and send `amount` as transaction value.
const amount = ethers.parseEther('0.1');
await factory.fund(id, ethers.ZeroAddress, amount, NO_CONSTRAINT, WEEK, ref, { value: amount });

// an ERC-20: approve the factory, then fund
const USDC = '0x…'; // the token's contract address
const usdc = new ethers.Contract(USDC, ['function approve(address spender, uint256 amount) returns (bool)'], signer);
await usdc.approve(await factory.getAddress(), 25_000_000n);
await factory.fund(id, USDC, 25_000_000n, NO_CONSTRAINT, WEEK, ref);
```

`fund` accepts the same arguments for native coin and ERC-20 deposits:

| Argument | Meaning |
| --- | --- |
| `identityHash` | Recipient commitment from `identityHash(type, value)` |
| `token` | ERC-20 contract address, or the zero address for native coin |
| `amount` | Amount in the asset's smallest unit |
| `constraint` | A 32-byte commitment to an additional claim requirement; zero for none |
| `refundWindow` | Seconds before an unclaimed deposit becomes refundable |
| `ref` | Application-defined 32-byte reference, emitted in `Funded`; zero for none |

The window must fall within the factory's configured limits. After it elapses, the funder calls
`refund(depositId)` on the vault. Contract interfaces are included; see [Solidity](#solidity).

`ref` is event-only metadata, not a claim constraint or an idempotency key. Repeated references
are allowed. Match a `Funded` event to an application record using its reference and identify
the deposit by chain, vault address and `depositId`. The contract does not store the reference
or interpret its contents. The `memo` URI parameter remains application text, not an onchain
funding argument.

These funding signatures apply to `p2id.vault.v2`. Its factory addresses must be configured
before use. Existing `p2id.vault.v1` deployments use the earlier signatures without `ref`;
use their original ABI when interacting with them.

## Read balances

Read native coin and ERC-20 balances at the derived address:

```ts
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
await provider.getBalance(to); // native coin

const token = new ethers.Contract(USDC, ['function balanceOf(address) view returns (uint256)'], provider);
await token.balanceOf(to); // ERC-20
```

## Identity types

Identity parameters accept an `IdentityType` enum value or a P2ID type name such as `'email'`,
`'x'` or `'github'` (`'twitter'` is accepted as an alias of `'x'`). P2ID core is agnostic of any
identity provider: it does not accept provider-specific account types (e.g. Privy's
`'twitter_oauth'`) — callers map those to P2ID names themselves. `resolveIdentityType` converts
these to the numeric IDs used in identity hashes, and `identityTypeName` gives the P2ID name of an
ID. The type table is append-only.

| `IdentityType.` | Id | Value | Example | Lowercased |
| --- | ---: | --- | --- | :---: |
| `Email` | 0 | address | `you@example.com` | yes |
| `Phone` | 1 | E.164 number | `+15551234567` | no |
| `Google` | 2 | email | `you@gmail.com` | yes |
| `X` (alias `Twitter`) | 3 | username, no `@` | `jack` | yes |
| `Discord` | 4 | username | `wumpus` | yes |
| `Github` | 5 | username | `octocat` | yes |
| `Linkedin` | 6 | email | `you@example.com` | yes |
| `Apple` | 7 | email | `you@icloud.com` | yes |
| `Telegram` | 8 | username | `durov` | yes |
| `Tiktok` | 9 | username | `charlidamelio` | yes |
| `Instagram` | 10 | username | `instagram` | yes |
| `Farcaster` | 11 | username | `dwr` | yes |
| `Wallet` | 12 | address | `0xA01b…0f98` or base58 | only `0x…` |

The same email produces different addresses under `Email`, `Google`, `Linkedin` and `Apple`.
Select the type the recipient will use to authenticate.

Handle reassignment can allow a new holder to claim remaining funds.

## Address derivation

```
identityHash = sha256( "p2id.identity.v1" ‖ byte(typeId) ‖ normalize(value) )
p2id         = keccak256( 0xff ‖ factory ‖ identityHash ‖ vaultInitCodeHash )[12..]
```

```ts
import { identityHash, p2idAddressForHash, p2idScheme, P2ID_SCHEME, IdentityType } from '@pvium/p2id-core';

const hash = identityHash(IdentityType.Email, 'you@example.com'); // identity commitment and vault salt
p2idAddressForHash(hash, { environment: 'sandbox' });        // same result as p2idAddress(...)

P2ID_SCHEME;   // 'p2id.vault.v2', the current address scheme
p2idScheme();  // { identityDomain, vaultInitCodeHash, factories: { production, sandbox } }
```

The formula excludes the chain ID. Addresses match across chains with standard CREATE2 semantics
when the factory address and vault creation bytecode match. `production` and `sandbox` use
separate factories.

An address scheme fixes the identity domain, factory addresses and vault creation-code hash.
Factory or vault bytecode changes require a new scheme. To derive an address under a previous
scheme, pass its name, for example `scheme: 'p2id.vault.v1'`.
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
await payByEmail.pay(proof, publicInputFields, hash, attestation.wallet, { value });
```

`verifyIdentity` checks the identity type, identity hash and wallet hash against the proof.
It reverts on failure and returns the attestation's issue time on success. Computing the wallet
hash on chain binds the payout address to the proof. Verification costs approximately 4.4M gas
with the current circuit.

For a wallet on another chain, such as a base58 Solana address, pass
`P2IDHash.walletHash("…")` with the wallet as a string.

## Exports

| Export | Purpose |
| --- | --- |
| `p2idAddress(input)` | Derive a vault address from `{ identityType, identityValue, environment?, scheme?, factory? }` |
| `p2idAddressForHash(hash, opts?)` | Derive a vault address from an identity hash |
| `identityHash(type, value, scheme?)` | Compute the identity commitment used as the vault salt |
| `P2ID_SCHEME`, `P2ID_SCHEMES`, `p2idScheme(name?)` | Read address-scheme constants |
| `IdentityType`, `IdentityTypeName`, `IDENTITY_TYPE_BY_NAME`, `resolveIdentityType` | Identity type IDs and name mappings |
| `normalizeIdentityValue`, `isCaseInsensitive`, `HASH_PREFIX` | Identity normalisation rules and hash prefix |
| `checksumAddress`, `toHex` | Address checksum and hexadecimal encoding |
