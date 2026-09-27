# Working on @pvium/p2id-core

For maintainers. Not shipped in the npm package.

```sh
yarn install                           # from sdks/node (a yarn workspace)
yarn workspace @pvium/p2id-core test    # copies ../../../contracts/src, embeds src/p2id.json, builds, tests
```

- `src/p2id.json` records every address scheme. While the current scheme has no factory recorded,
  `node scripts/embed-p2id.mjs --update` refreshes its vault creation-code hash from the Hardhat
  artifact. Once a factory is recorded the scheme is frozen and the build fails on drift; a vault
  change then ships as a new scheme entry with its own salt name.
- `contracts/` is generated from `../../../contracts/src` at build time. Never edit it here.
- **Publishing.** The SDK may be published before a production factory is recorded. In that state,
  `p2idAddress()` rejects production derivation unless the caller supplies `factory` explicitly;
  sandbox derivation works when its factory is recorded. Publish this package before
  `@pvium/p2id-verifier`, which depends on it.
