# sdks

Client libraries for Pvium identity proofs. Each SDK bundles the circuit's verification key and
knows the public-input layout, so consumers can verify proofs and decode claims without any
other artifact.

| Folder | Package | Status |
| --- | --- | --- |
| `node/p2id-core/` | `@pvium/p2id-core` (npm) | identity hashing, P2ID address derivation on EVM (root, `/evm`) and Solana (`/solana`), Solidity sources and Anchor IDLs; browser-safe |
| `node/p2id-verifier/` | `@pvium/p2id-verifier` (npm) | verify attestations (Ethereum UltraHonk, Solana Groth16) + decode claims; depends on core |
| `python/` | | planned |
| `go/` | | planned |

All SDKs must agree on: the public-input order in `circuit/src/main.nr`, the identity type ids in
`circuit/src/identity.nr`, the `p2id.identity.v1` hash prefix, and the low-s signature rule for
provers. When the circuit changes, every SDK re-syncs its vk and publishes a new version.
