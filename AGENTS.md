# Agent instructions for `circuits/`

Pvium zero-knowledge identity proofs: Noir circuit, attestation prover service, Node SDK, Solidity verifier.

## Package manager

**Use `yarn` for every JavaScript/TypeScript package in this repo. Never use `npm` or `npx`.**
Install with `yarn install`, run scripts with `yarn <script>`, run binaries with `yarn <bin>`
(e.g. `yarn hardhat test`). Commit `yarn.lock`; do not create `package-lock.json`.

## Toolchain on this machine

- **Node**: use the nvm install, not the Homebrew one (the Homebrew Node 15 at
  `/usr/local/bin/node` is broken and hangs). Put it first on `PATH` before any node/yarn command:
  `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"`
- **Noir**: `nargo 1.0.0-beta.26` at `~/.nargo/bin`, paired with **Barretenberg**
  `bb 5.0.0` at `~/.bb`. These versions are pinned to each other; do not bump one
  without the other. `export PATH="$HOME/.nargo/bin:$HOME/.bb:$PATH"`
- **Go**: `/usr/local/go/bin/go` (1.25) for a future `sdks/go`.
- **Python 3** is used only for `circuit/scripts/gen_prover.py`.

## Layout

| Folder | Contents |
| --- | --- |
| `circuit/` | Noir circuit (`src/`), witness generator (`scripts/`), e2e test + sample token/keys (`test/`) |
| `contracts/` | Hardhat 2 + ethers v6 project: generated Honk verifier, `PviumIdentity` (dev API), `P2IDVault` + `PviumVerifier`; `src/interfaces/`, `src/lib/P2IDHash.sol` |
| `sdks/node/` | yarn workspace of two npm packages: `p2id-core` (`@pvium/p2id-core`: identity hashing, P2ID address derivation, ships the Solidity sources; browser-safe, no bb.js) and `p2id-verifier` (`@pvium/p2id-verifier`: bb.js proof verification, vk, claim decoding, Privy environments; depends on core). `sdks/python`, `sdks/go` later |
| `http-prover/` | Attestation service (Express 5, `--env-file=.env`, noir_js solve, native `bb` prove). `yarn sync` copies circuit artifacts |

## Workflow rules

- **A released contract source is never edited.** The stack is live, and every deployed address is
  the hash of a contract's creation code, so an edit (even a constructor argument added for a test)
  makes the checkout unable to rebuild what is on chain. A change is a new file and a new contract
  next to the old one: `P2IDVaultV2`, `PviumVerifierV2`, `PviumZKVerifierV2`, `PviumP2IdVaultFactoryV2`
  (the factory with a configurable notice; nothing deploys it, and a stack built on it would be a
  new address scheme). `contracts/releases.json` is the manifest: the circuit version each scheme's
  factory was deployed with, each circuit version's vk hash and its own `PviumZKVerifier…` /
  `PviumVerifier…` contracts, the vault implementations released after the built-in `P2IDVault`, and
  the owner settings each environment should have now. `test/ReleaseParity.test.ts` rebuilds every
  record in `contracts/deployments/` and every prepared vault Safe batch from the checkout and
  compares addresses; it must stay green. Tests that need to pass the factory's 14-day notice
  advance local time; they do not shorten the notice.
- The ZK verifier is **generated** by `bb write_solidity_verifier`, one file per circuit version:
  `contracts/src/PviumZKVerifier.sol` for circuit v1, `PviumZKVerifierV<N>.sol` (contract
  `PviumZKVerifierV<N>`, renamed from bb's `HonkVerifier` by the refresh script) from v2 on. Scripts
  and tests pick a version's contracts through `circuitRelease(N)` / the test helper's `CURRENT`,
  never a fixed name; every generated file declares the same library names, so those are addressed
  by file (`src/PviumZKVerifierV2.sol:RelationsLib`).
  Never hand-edit a generated file. After any circuit change: `nargo compile`, `nargo execute`, `bb prove`,
  then `yarn fixtures` in `contracts/` to refresh test fixtures and the verifier, and `yarn sync`
  in `sdks/node/` (`yarn workspace @pvium/p2id-verifier sync`) to refresh its bundled vk and fixtures.
  `yarn fixtures` writes the file named in `releases.json` for `circuit/version.json`'s version and
  refuses when that version's recorded vk hash differs from the compiled one: a changed circuit is a
  new `circuitVersion`, a new `releases.json` entry, and its own verifier files.
- **Circuit versioning**: `circuit/version.json` names the current build (`circuitVersion`, vk sha256).
  Bump `circuitVersion` whenever the compiled circuit changes, then sync all consumers (`yarn fixtures`
  in contracts, `yarn sync` in sdks/node and http-prover). The prover serves one version and echoes it
  in every attestation (one release branch and prover deployment per version, e.g.
  `releases/circuit/v1`); `PviumIdentity` is deployed once per version. `@pvium/p2id-verifier`
  bundles every shipped version's vk side by side (`src/circuits/v<N>.{vk,json}`; `yarn sync` adds
  or refreshes the current one and never removes older ones), selects the vk from the attestation's
  `circuitVersion`/`vkHash`, and exposes a pinned entry point per version
  (`@pvium/p2id-verifier/v<N>`, `src/v<N>.ts` plus a `package.json` export). Old attestations stay
  valid; they are not regenerated in bulk.
- **One command brings a chain to the current release.** In `contracts/`,
  `yarn hardhat run scripts/deploy-deterministic.ts --network <chain>` deploys the scheme's stack
  from the circuit version its factory was first deployed with (so any checkout gives the deployed
  addresses), then everything in `releases.json`: each later circuit version's verifier set, and the
  owner transactions the chain still lacks (bind the policy to its factory, the environment's alpha
  attester and constraint signers, approve each later verifier, deploy and propose each later vault
  implementation, register it once its notice has passed). Owner transactions are sent when the
  deployer key is the owner (sandbox); otherwise each is simulated as the owner and written to
  `deployments/safe/` as a Safe Transaction Builder batch: one file per step, plus
  `<scheme>.<env>.<chainId>.owner-pending.json` holding all of them in order. It is re-runnable on
  any chain at any time and skips what is there, so it is also how an existing chain picks up a new
  release: add the contract and its `releases.json` entry, then run it on every chain.
  `PREDICT=1` prints every address offline; `PLAN=1` reads the chain and writes the Safe batches
  but sends nothing and needs no key; `STACK_ONLY=1` stops after the stack.
- **Deploying a new circuit version** never touches the factory, policy or any P2ID address.
  The command above covers it. To do only that step, in `contracts/`:
  `yarn deploy:verifier --network <chain>` (`PREDICT=1` first) deploys only that
  version's ZK verifier, `PviumIdentity` and `PviumVerifier` next to the chain's recorded
  stack, reads them back and writes `deployments/<scheme>.<env>.circuit-v<N>.<chainId>.json` with
  their activation status; it sends no owner transaction. `yarn verifier:activate --network <chain>`
  shows the status and the owner's next transactions; `STEPS=approve[,release-alpha,propose-default,activate-default]`
  sends them from the owner key, or (production: the policy and factory owner is a Safe) writes a
  Safe Transaction Builder batch under `deployments/safe/`. Rerun it after the Safe executes to
  record the new status. Keep the previous version's verifier approved and its
  prover (`releases/circuit/v<N>`) running until its deposits are claimed or refunded.
- The Solidity sources in `contracts/src` are the source of truth; `sdks/node/p2id-core/scripts/sync-contracts.sh`
  copies them into the npm package at build time (gitignored there). Never edit `sdks/node/p2id-core/contracts/`.
- `http-prover/src/witness.ts` is a port of `circuit/scripts/gen_prover.py`; `http-prover/test/witness.test.ts`
  diffs their output byte for byte. Change both together. `@noir-lang/noir_js` in `http-prover/` is pinned
  to the nargo version (`1.0.0-beta.26`).
- Hash/normalisation rules must stay identical in four places: `circuit/src/main.nr` + `identity.nr`,
  `circuit/scripts/gen_prover.py`, `contracts/src/lib/P2IDHash.sol`, `sdks/node/p2id-core/src/identity.ts`.
- `@aztec/bb.js` in `sdks/node/p2id-verifier` must be pinned to the same version as the installed `bb`
  (`5.0.0`): proofs and vks are not portable across versions.
- `P2ID.md` at the repo root is the protocol spec (address formula, identity type ids). The type
  table is append-only: never reassign or reuse an id; keep identity.nr, P2IDHash.sol, the SDK
  and the prover in step and update P2ID.md with them.
- The identity-hash domain prefix is `p2id.identity.v1`; it names the hash formula and never
  changes with address-scheme or circuit versions (proofs stay valid across vault changes).
  Prefixes are dot-separated (`p2id.<component>.vN`); the vault salt is the versionless `pvium.vault.v1`.
- **Vault implementations live behind a proxy: storage layout is frozen.** Every P2ID address is a
  `PviumP2IDVaultProxy` delegating to a registered `P2IDVault` implementation, and an owner may move
  a vault between implementations, so all of them share one storage layout. Before changing vault
  code:
  - never reorder, remove, retype or insert state variables in `P2IDVault`; append new ones at the
    end only. Mappings and structs count: a struct field change changes the layout;
  - **The stack is live (Base, BSC, Ethereum): `contracts/src/P2IDVault.sol` is frozen.** It keeps
    alpha and post-alpha behavior together; do not create a duplicate alpha vault or parallel
    copies of ordinary vault logic. A change is a new contract (`src/P2IDVaultV2.sol` is the first),
    not an edit of the deployed one. It keeps
    `acceptOwnerProof` (returning its selector), never uses `delegatecall`
    or `selfdestruct`, and never defines the proxy's reserved selectors (`implementation()`,
    `lastUpgrade()`, `upgradeTo(bytes32,address,bytes)`, `alphaUpgradeNonceUsed(uint256)`, and
    `upgradeToWithAttestation(bytes32,address,bytes,(uint256,uint256,bytes))`);
  - **Keep vault business logic in the implementation, never in the proxy.** Sweeps, proof
    refreshes, fee withdrawals, their `*WithAttestation` variants, the business authorization
    wrapper, and its used-nonce mapping belong in `P2IDVault` (or a later storage-compatible implementation).
    The proxy delegates these calls and must not define or intercept their selectors. Only
    proxy management, including `upgradeTo` and its own signed authorization, lives in the proxy.
    Alpha status is keyed by the pinned verifier vkHash, never caller proof metadata.
    Only proof-verifying methods take alpha attestations; proofless sweeps require a current
    owner cache. Enabling alpha for a key or changing a verifier key invalidates its old caches.
    This avoids freezing business APIs into proxy bytecode and changing every P2ID address when
    a vault behavior changes. `IP2IDVault` is the single business interface for alpha and
    post-alpha calls; do not create a separate alpha vault interface. `IP2IDVaultProxy` is
    the proxy-management API. Run the ABI-boundary regression test in `StorageLayout.test.ts`.
  - New factories start on the single `P2IDVault`, with alpha state appended to the original
    layout. Compare candidates against the original snapshot and the current implementation
    before registering. The factory refuses to propose, register or default to an implementation
    unless `factory()` is this factory, `supportsAlphaGuard()` is true and `p2idVersion()` is
    `p2id.vault.v1`; the proxy re-checks the alpha guard at upgrade time. Alpha-capable upgrade
    targets must preserve the guard and return true from `supportsAlphaGuard()` even if alpha is
    currently disabled, so it can be safely re-enabled later. Those markers are compatibility
    claims, not a code audit.
  - The alpha addition must retain ordinary vault method bodies and internal operations.
    Run `VaultAlphaParity.test.ts` to check them against the pre-alpha business-body hashes, remaining source hash and ABI
    fixture and exercise ordinary execution with alpha off. That fixture is a regression
    baseline, not a second implementation. Intentional changes to ordinary behavior must
    be reviewed explicitly and update the regression baseline with their own validation.
  - run `CANDIDATE=<Contract> yarn layout` in `contracts/` and fix every error before proposing it;
    `yarn layout` alone checks the base still matches `contracts/storage/P2IDVault.layout.json`.
    `UPDATE=1 yarn layout` rewrites that snapshot and is only legitimate while no factory is deployed;
  - add it to `vaultImplementations` in `contracts/releases.json` and run `deploy-deterministic.ts`
    on each chain: it deploys and proposes it through the factory and, on a run after the 14-day
    notice, registers it (Safe batches when the owner is a Safe). For that step alone:
    `FACTORY=<factory> CANDIDATE=<Contract> MAKE_DEFAULT=true yarn deploy:implementation --network <chain>`
    (dry run; `EXECUTE=1` sends, `ACTION=activate` registers). The scheme name, salt and factory never change
    for a vault change; `pvium.vault.vN` bumps only if the *proxy or factory* code changes after a
    mainnet release.
- **Fees: the rate lives in the policy, the ceiling in the factory, and the timelock is the
  policy switch.** `PviumP2IdVaultFactory.MAX_FEE_BPS` (1%) is a constant with no setter; vaults
  clamp every quote to it. The rate is `IP2IDPolicy.feeBps(verifier, token)`, frozen into each
  deposit at funding and handed to the policy at claim time through `collectFee`: the vault
  transfers the fee and announces it in one atomic self-call (`pushFeeToPolicy`) under a gas
  stipend, so a reverting policy receives nothing and the fee goes to the recipient. The vault
  never grants an allowance, never accrues and never holds fees. A policy must verify receipt
  before booking (any contract can call `collectFee`). A policy must never expose an instant
  rate setter: a new rate is a new policy contract, activated through `proposePolicy` →
  `policyChangeDelay` → `activatePolicy`, so every rate change carries the public notice. Do not
  add fee state, a fee cap setter or a fee withdrawal path to the vault or the factory.
- Tests and their fixtures live in each package's `test/` folder (`circuit/test`, `contracts/test`).
  Sample token/keys are in `circuit/test/fixtures`; `contracts/test/fixtures` is a copy refreshed by
  `yarn fixtures`. Run `sh test/e2e.sh` in `circuit/` after changing the circuit or script.
- **Gate budget**: the circuit is ~1,323k gates (the JSON nesting tracker added ~176k), padded to 2^21 (1,048,576 was crossed on
  purpose when the wallet slot was added; proofs are generated offline at enrollment, so ~9 s /
  2.5 GB per proof is acceptable). The next ceiling is 2,097,152. Measure with
  `bb gates -b target/pvium_identity.json` after every circuit change.
- After a circuit change run `sh test/e2e.sh` and `sh test/adversarial.sh` in `circuit/` before
  re-proving; the adversarial suite is the regression test for the anchoring audit finding.
- Circuit compile and prove steps take one to several minutes; run them in the background and
  do not stack redundant runs.
- `circuit/test/fixtures/sample_token.jwt` is a real (expired) Privy identity token for a test user, with
  Privy's key in `privy_es256_public.pem`; `test_es256_*.pem` is a throwaway pair used only by the
  adversarial tests to sign decoy payloads.
