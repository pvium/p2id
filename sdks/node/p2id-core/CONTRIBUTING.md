# Working on @pvium/p2id-core

For maintainers. Not shipped in the npm package.

```sh
yarn install                           # from sdks/node (a yarn workspace)
yarn workspace @pvium/p2id-core test    # copies ../../../contracts/src, embeds src/p2id.json, builds, tests
```

- `src/p2id.json` records every address scheme. While the current scheme has no factory recorded,
  `node scripts/embed-p2id.mjs --update` refreshes its vault creation-code hash from the Hardhat
  artifact. Once a factory is recorded the scheme is frozen and the build fails on drift; a vault
  change then ships as the next `p2id.vault.vN`.
- `contracts/` is generated from `../../../contracts/src` at build time. Never edit it here.
- **Publishing.** `prepublishOnly` refuses to publish while the current scheme has no production
  factory, because `p2idAddress()` would throw for every user. Record it first (see `DEPLOYMENT.md`
  at the repository root). Publish this package before `@pvium/p2id-verifier`, which depends on it.
