# Pvium ZK

Zero-knowledge circuits and proof tooling for Pvium.

**[P2ID.md](P2ID.md)** is the protocol specification: how an identity (email, social handle, phone,
wallet) maps to a chain-agnostic address, the identity type ids, and how a claim works.
**[DEPLOYMENT.md](DEPLOYMENT.md)** is the runbook: contracts, prover, SDK and API, in order.

| Folder | Purpose |
| --- | --- |
| `circuit/` | Noir circuit: proves a Privy identity token contains a linked account and wallet |
| `sdks/node/p2id-core/` | npm package `@pvium/p2id-core`: identity hashing, P2ID address derivation, the Solidity sources. Browser-safe |
| `sdks/node/p2id-verifier/` | npm package `@pvium/p2id-verifier`: verify attestations off-chain (depends on core) |
| `http-prover/` | Attestation service: token in, proof out (Express + noir_js + native bb) |
| `contracts/` | On-chain verification, per-identity vaults and the vault factory |
