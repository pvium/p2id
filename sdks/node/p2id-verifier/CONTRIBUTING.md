# Working on @pvium/p2id-verifier

For maintainers. Not shipped in the npm package.

```sh
yarn install                                  # from sdks/node: links the local @pvium/p2id-core
yarn workspace @pvium/p2id-verifier test       # embeds the vk, builds, runs the tests on a real proof
```

When the circuit changes:

```sh
yarn workspace @pvium/p2id-verifier sync       # copy the new vk and sample proof from ../../../circuit
yarn workspace @pvium/p2id-verifier test
```

then publish a new version alongside the redeployed verifier contract. `@aztec/bb.js` must stay
pinned to the Barretenberg version that built the circuit. Identity hashing comes from
`@pvium/p2id-core`, so there is one implementation of the hash a proof commits to.
