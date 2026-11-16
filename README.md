# Pvium ZK

This repository implements P2ID payment protocol: derive a vault address from an email address,
social handle, phone number or wallet identifier, then send funds to that address. The
recipient claims the funds by proving that their identity is linked to a payout wallet.
The address can receive funds before the recipient registers or the vault is deployed.

You can use Pvium's reference deployment or deploy your own P2ID setup. Your own factory
creates a separate set of deterministic vault addresses for the same identities, comparable
to operating in a different payment namespace. Applications must use the factory address
and vault creation-code hash for the deployment they intend to pay.

Pvium's proof system uses Privy-signed identity tokens. The prover creates a zero-knowledge
attestation that a token links the requested identity and wallet. Applications can verify
that attestation with the Node SDK; vaults verify it through the Solidity contracts before
paying the authenticated wallet.

Direct transfers to a vault have no refund right. Payments made through the factory's
funding methods create deposit records that the funder can refund after the chosen window
if they remain unclaimed.

## Documentation

- [P2ID protocol specification](P2ID.md): identity normalization, hashing, address calculation,
  payment URIs, and contract requirements.
- [Set up P2ID payments](DEPLOYMENT.md): use Pvium’s reference deployment or deploy your
  own setup, connect a verifier, and fund payments.
- [Contract documentation](contracts/README.md): contract APIs and development commands.
- [Self-host the HTTP prover](http-prover/README.md): configuration, Docker, Railway, VPS
  deployment, HTTP API, and tests.

## Repository layout

| Folder                     | Contents                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `circuit/`                 | Noir circuit, witness generator, and circuit tests                                                                         |
| `contracts/`               | Solidity verifier, vault factory, vault proxy and implementation, and policy                                               |
| `sdks/node/p2id-core/`     | `@pvium/p2id-core`: identity hashing, vault address derivation, and bundled Solidity sources; usable in browsers             |
| `sdks/node/p2id-verifier/` | `@pvium/p2id-verifier`: off-chain Ethereum attestation verification with a bundled verification key                          |
| `http-prover/`             | HTTP service that generates Ethereum proofs with Barretenberg or Solana proofs with Sunspot from Privy tokens                |
| `solana-anchor/`           | Anchor CPI wrapper that forwards Sunspot proofs to a caller-selected Solana verifier program                                 |
| `solana-test/`             | Local Solana clients for testing the verifier directly or through the Anchor wrapper                                         |

## Use the SDK

Install the address-derivation package in your application:

```sh
yarn add @pvium/p2id-core
```

```ts
import { IdentityType, p2idAddress } from '@pvium/p2id-core';

const address = p2idAddress({
  identityType: IdentityType.Email,
  identityValue: 'you@example.com',
  environment: 'sandbox',
});
```

Use `sandbox` for the testnet factory and `production` for the mainnet factory. Production
is the default when `environment` is omitted. Send funds only on a chain with the matching
factory deployment; deriving an address does not check whether contracts exist on that chain.

See the [core SDK guide](sdks/node/p2id-core/README.md) for funding examples and the
[verifier SDK guide](sdks/node/p2id-verifier/README.md) for checking attestations.

## Develop locally

Use Yarn for JavaScript and TypeScript packages. The prover requires Node 22.13 or newer;
CI uses Node 24. Install dependencies separately in `contracts/`, `sdks/node/`, and
`http-prover/` with `yarn install`.

Run `yarn test` in each of those directories. The SDK workspace command tests both packages.
Circuit tests run from `circuit/` with `sh test/e2e.sh` and `sh test/adversarial.sh`.
The Anchor wrapper's Rust unit tests run with `cargo test --manifest-path solana-anchor/Cargo.toml`.
See the [circuit guide](circuit/README.md) for circuit build and proof-generation commands.

The pinned proof toolchain is `nargo 1.0.0-beta.26` with `bb 5.0.0`. The prover's
`@noir-lang/noir_js` and the verifier SDK's `@aztec/bb.js` must match those versions.
After changing the compiled circuit, bump `circuit/version.json` and refresh the contracts,
SDK, and prover artifacts together as described in [AGENTS.md](AGENTS.md).

## Test the Solana route locally

The Solana proof route uses Sunspot to generate a proof, then the Anchor wrapper invokes the
Sunspot verifier by CPI. Prepare the circuit artifacts and the Solana attestation first, then
start a local validator with the generated Sunspot verifier, deploy the Anchor wrapper, and run
the Anchor client. The ordered commands, environment setup, direct-verifier alternative, and
local-only trusted-setup warning are in the [Solana route guide](SOLANA-ROUTE.md).

The attestation response saved as `solana-test/data.json`, circuit witness inputs, and program
keypairs are local test data and are ignored by Git. Never commit generated JWTs, witnesses,
proof responses, environment files, or keypairs. The committed sample JWT, sample proof files, and
throwaway signing key under the test fixture directories are intentional test fixtures only; do
not use them in production.
