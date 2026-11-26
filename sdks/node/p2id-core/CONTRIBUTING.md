# Working on @pvium/p2id-core

For maintainers. Not shipped in the npm package.

```sh
yarn install                           # from sdks/node (a yarn workspace)
yarn workspace @pvium/p2id-core test    # copies ../../../ethereum/src, embeds src/p2id.json, builds, tests
```

- `src/p2id.json` records every address scheme. While the current scheme has no factory recorded,
  `node scripts/embed-p2id.mjs --update` refreshes its vault creation-code hash from the Hardhat
  artifact. Once a factory is recorded the scheme is frozen and the build fails on drift; a vault
  change then ships as a new scheme entry with its own salt name.
- The `solana` block of each scheme holds the program ids and, per environment, the factory and
  verifiers as deployed. `node scripts/embed-p2id.mjs --update` fills them from the records
  `yarn deploy` writes to `../../../solana-anchor/deployments/`; the build recomputes the factory
  PDA from the recorded authority and parameters and fails on any mismatch. A recorded production
  factory freezes the block like the EVM one. The program ids come from the programs' `declare_id!`.
- `ethereum/` is generated from `../../../ethereum/src` at build time, `solana/idl/` from
  `../../../solana-anchor/target/idl` (run `anchor build` there first). Never edit either here.
- **Publishing.** The SDK may be published before a production factory is recorded. In that state,
  `p2idAddress()` rejects production derivation unless the caller supplies `factory` explicitly;
  sandbox derivation works when its factory is recorded. Publish this package before
  `@pvium/p2id-verifier`, which depends on it.
