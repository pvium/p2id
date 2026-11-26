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

## Solana keys

Solana proofs are Groth16 (Sunspot/gnark) and verified in pure JS (`src/solana/groth16.ts`, a
port of the verifier program's check, commitments included). Each environment has its own trusted
setup, so its own key:

```sh
# after circuit/scripts/sunspot-build.sh <env> and sunspot-prove.sh <env>
yarn workspace @pvium/p2id-verifier sync --solana sandbox      # src/circuits/solana/sandbox.v<N>.{vk,json}
yarn workspace @pvium/p2id-verifier sync --solana production   # after the ceremony
yarn workspace @pvium/p2id-verifier test
```

`sync --solana` also copies the sample proof to `test/fixtures/solana/` and records the Solana
program id (`zkVerifier`) from the environment's keypair. The build refuses a key whose hash or
program differs from what `@pvium/p2id-core` records as deployed for that environment and version
(`p2id.json`, `solana.verifiers`), so the SDK never verifies under a key the chain does not use.
The sandbox key is single-party until the devnet deployment is recorded; the production key comes
from the phase-2 ceremony.
