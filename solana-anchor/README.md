# P2ID on Solana

Four programs live here.

- `programs/p2id_router` owns every account and holds every balance: a `Factory` PDA with the
  default verifier, policy, refund bounds and the registered implementations, a `VerifierConfig` PDA
  per verifier, one `Vault` PDA per identity, one `Deposit` PDA per recorded deposit. It is deployed
  once and made immutable, so the code holding funds can never change. It exposes the factory
  administration, refunds and untracked sweeps directly, and a small set of state-changing
  primitives only a vault's implementation may call.
- `programs/p2id_vault` is the first implementation (EVM `P2IDVaultV2` semantics) and the program
  users talk to: `fund_*`, `refresh_proof`, `claim_*`. It verifies identity proofs and asks the
  router to record the result and move the money. It owns nothing and holds no funds. A later
  implementation is a new program, registered by the factory behind notice; each vault owner moves
  their vault to it, or does not.
- `programs/p2id_policy` is the fee policy (`PviumP2IDPolicy`): the router asks it for the rate at
  funding and reports fees to it at settlement.
- `programs/p2id_solana_verifier` is the verifier for circuit v2: it implements the verifier
  interface (below) in front of the Sunspot-generated Groth16 program, checking the witness layout
  and returning the attestation. `crates/p2id_verifier_interface` is the interface itself.
  `programs/test_verifier` (a stand-in for the Sunspot program: accepts any proof) and
  `programs/test_hook` (a Token-2022 transfer hook that counts transfers) exist only for the local tests.

## Router and implementations

On Solana only an account's owner program can write its data or debit its lamports, and a program
cannot call back into a program that is already on the call stack. So the split is: accounts and
balances in the router, proof logic in implementations, and calls flow one way, user →
implementation → router (→ policy), and implementation → verifier (→ its proof-system program).

An implementation signs its router calls with its authority PDA
(`PDA(["p2id.impl-authority.v1"], implementationProgram)`), and the router accepts the call only if
that PDA belongs to `vault.implementation`. The gated primitives are `create_deposit_sol/token`,
`set_owner_cache` and `settle_sol/token`. On every settlement the router itself enforces what no
implementation may waive: the deposit is unconsumed and settles once, for its amount less the fee
quoted when it was funded, to the owner proven under the verifier the deposit pins and under the
present signer-key set, with the deposit's constraint attested earlier in the transaction. Refunds
(`refund_sol/token`) and untracked sweeps are plain router instructions, so a broken or hostile
implementation cannot stop a refunder taking an unconsumed deposit back after its window.

The factory registers implementations the way the EVM factory does: `propose_implementation(program,
make_default)`, then `register_implementation` after the 14-day notice (`cancel_implementation_proposal`
in between); `set_default_implementation` picks, among registered ones, what new vaults start on.
Nothing ever unregisters an implementation, so a vault keeps the one its owner chose. The cached
owner moves a vault with `set_vault_implementation(program)` (router, owner signs, cache must be
current); nobody else can.

The implementation programs' upgrade authority is burned at deploy and the router's as well, which
is the point: the only way behaviour changes for a vault is a new program the factory announced two
weeks earlier and the owner opted into. The router does not take this on trust: `initialize_factory`,
`register_implementation` and `activate_verifier` read the program's loader state (its ProgramData
account under the upgradeable loader, the status under loader-v4) and refuse a program that still has
an upgrade authority, or that is not deployed at all. Burning comes before registering.

## Addresses

```text
factory    = PDA(["p2id.factory.v1", "pvium.vault.v1", authority, paramsHash], p2id_router)
verifier   = PDA(["p2id.verifier.v1", factory, verifierProgram],                 p2id_router)
policy     = PDA(["p2id.policy.v1", authority, p2id_router, feeBps_be_u16],      p2id_policy)
paramsHash = sha256("p2id.factory.params.v1" || nKeys_u8 || signerKey_1 || … || defaultVerifier || policy
                    || defaultImplementation || alphaAttester || circuitVersion_be_u16 || vkHash
                    || minRefundWindow_be_i64 || maxRefundWindow_be_i64)
vault      = PDA(["p2id.vault.v1", factory, identityHash],    p2id_router)
deposit    = PDA(["p2id.deposit.v1", vault, depositId_le_u64], p2id_router)
vaultMint  = PDA(["p2id.vault-mint.v1", vault, mint],           p2id_router)
implAuth   = PDA(["p2id.impl-authority.v1"],                    implementationProgram)
```

`authority` is the key that administers the factory (verifier, policy and implementation
proposals). It and `paramsHash`, a commitment to every other `initialize_factory` argument, are
arguments, not signers, and both are part of the factory address, as the EVM factory's constructor
arguments are part of its CREATE2 address. Anyone may submit the instruction and pay the rent, and
the only factory they can create at an address is the one with exactly that authority and those
terms; other values land at an unrelated address. A deployment is therefore reproducible from
`(programId, authority, params)` by any key, and cannot be squatted. In production the authority
is a Squads multisig vault; the tests use the provider keypair. The vault PDA includes the factory,
so each factory has its own set of vaults. `identityHash` is the P2ID identity commitment from
`P2ID.md`, unchanged from the EVM scheme.

## Owner changes carry notice

The authority changes the default verifier, the fee policy and the implementation set only through
a proposal that becomes activatable after a delay, as the EVM factory does: `propose_verifier` /
`activate_verifier`, `propose_policy(policy)` / `activate_policy` and `propose_implementation` /
`register_implementation`, each with a `cancel_*` counterpart. All delays start at 14 days. The
policy is a `PolicyConfig` account of the policy program whose rate is one of its seeds, so a new
rate is a new policy address that has to go through the notice, exactly as a new `PviumP2IDPolicy`
contract does on EVM; rates are capped at `MAX_FEE_BPS` (1%) on both sides. A deposit keeps the rate
quoted when it was funded; the policy live at settlement receives the fee. Nothing changes a fee,
a verifier or an implementation instantly.

**Fee policy program.** `initialize_policy(authority, vault_program, fee_bps)` creates a policy
(`vault_program` is the router); `set_factory` binds it once (fees are refused before). The router
calls `quote_fee(verifier, mint)` by CPI at funding and freezes the answer into the deposit
(`IP2IDPolicy.feeBps`); at settlement it transfers the fee to the policy account (SOL) or the
policy's associated token account, then calls `collect_fee_sol` / `collect_fee_token` signed as the
vault, and the policy books the amount only if its balance shows it arrived (`collectFee`).
`withdraw_fees_*` pays booked fees out to the authority's chosen account. The policy never holds an
allowance, never pulls funds and never blocks on anything but the receipt check. Two deviations
from EVM: a failing policy fails the settlement rather than waiving the fee (a Solana CPI error
cannot be caught), which is why the policy only books receipts, and a zero fee skips the call.

## Claims, owner cache and refunds (EVM P2IDVault parity)

| EVM                                                                           | Solana (program)                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fund`, `fundWith(verifier, …)`, `fundWithRefunder(…, refundAddress, …)` (V2) | one instruction per asset: `fund_sol` / `fund_token(amount, constraint, refund_window, refunder?, reference)` (implementation); the verifier is the `verifier_config` account passed (the default's for plain funding), `refunder` null means the funder |
| `refreshProof(verifier, proof)`                                               | `refresh_proof(proof)` with any allowed `verifier_program` (implementation); the verifier's accounts follow as remaining accounts                                                                                                                        |
| `refreshProofAndSweep` / `sweepDeposits`                                      | `claim_sol` / `claim_token(id)` with a registered proof: `register_proof` first, then the buffer and its registerer as the claim's optional accounts (implementation)                                                                                                                                                                                                  |
| `sweep` (proofless, cached owner)                                             | the same instructions without a proof buffer                                                                                                                                                                                                              |
| `sweepBucket(…, Constraint{commitment, signature}, …)`                        | the same instructions, preceded in the transaction by an Ed25519 instruction (see below)                                                                                                                                                                 |
| `*WithAttestation(…, AlphaAttestation)` / `executeWithAttestation`            | the same instructions, preceded by the alpha attester's Ed25519 instruction while the verifier is in alpha (see below)                                                                                                                                   |
| `setAlpha(vkHash, enabled)`, `setDefaultAttester`                             | `set_alpha(enabled)` per verifier config, `set_alpha_attester` on the factory                                                                                                                                                                            |
| `sweepUntracked(token)`                                                       | `sweep_untracked_sol` / `sweep_untracked_token` (router)                                                                                                                                                                                                 |
| `refund(depositId)`                                                           | `refund_sol` / `refund_token(id)` (router)                                                                                                                                                                                                               |
| (none: consumed deposits cost nothing to keep on EVM)                         | `close_deposit(id)` (router, permissionless): returns a consumed deposit record's rent to its funder                                                                                                                                                     |
| `upgradeTo(implementation)` on a vault                                        | `set_vault_implementation(program)` (router, cached owner signs)                                                                                                                                                                                         |
| `Funded`, `Claimed`, `Refunded`, `OwnerRefreshed`, `Swept` events             | `Funded`, `Claimed`, `Refunded`, `OwnerRefreshed`, `UntrackedSwept`, plus `ImplementationRegistered`, `VaultImplementationChanged` (all emitted by the router)                                                                                           |

Nobody signs a claim but the transaction fee payer: `owner` is a plain destination account, so a
relayer can submit a user's proof and pay the fees, as on EVM. With a proof, `owner` must be the
wallet the proof names (public inputs 9-10 commit to its base58 string, type 12). The newest
accepted proof makes its wallet the vault's cached owner; a same-age proof must name that owner;
an older proof is refused, so a leaked proof can never roll the owner back. Later deposits can be
claimed for the cached owner with an empty proof and witness while the cache is current: the
deposit pins the verifier the owner was proven under and no signer key has been removed since.
Token claims create the payee's and the policy's associated token accounts when missing (rent paid
by `payer`). A deposit can be refunded only after `funded_at + refund_window`, by the refunder named
at funding or, when none was named, by the funder (P2IDVaultV2 semantics: a named refunder is the
one account that may refund and is paid); the payee may claim at any time until that happens.

The implementation follows the current EVM release, `P2IDVaultV2` and `PviumVerifierV2`; it does
not reproduce behaviour of the first implementation that V2 changed.

**Constraints.** A deposit funded with a nonzero `constraint` (a screening commitment) is released
only if an earlier instruction of the same transaction is the Ed25519 program verifying a signature
by one of the deposit's verifier's `constraint_signers` over `"p2id.constraint.sol.v1" || factory || commitment`.
The runtime checks the signature; the router reads the instructions sysvar at settlement to confirm
which key signed what. The authority adds and removes a verifier's constraint signers immediately
(`set_constraint_signer`), as the EVM verifier owner does; funding with a constraint is refused
while the chosen verifier has none (EVM: `supportsConstraints()`).

**Alpha.** A verifier is as trustworthy as its circuit, and a soundness bug in a live circuit is
invisible on-chain: the proof passes. The one party with independent evidence is the backend, which
issued the identity token and knows which wallet that identity authenticated with. So every verifier
starts in alpha (EVM `isAlpha(vkHash)`), and while it is, every payout under it needs the factory's
`alpha_attester` (an ed25519 key held by the backend) to have approved that exact action: an earlier
Ed25519 instruction in the same transaction over
`"p2id.alpha.sol.v1" || deadline_le_i64 || sha256(factory || vault || verifier || destination || iat_le_i64 || action || subject || epoch_le_u64)`.
The attester can withhold, never move funds: every router invariant still applies. Gated:
`refresh_proof` (action 1), `claim_*` with or without a proof (2, subject = the deposit),
`sweep_untracked_*` (3, subject = the mint, zero for SOL) and `set_vault_implementation` (4, subject
= the program). Refunds and `close_deposit` are never gated. `iat` is the owner's proof time after
any update the instruction carries, so an approval names the proof it was given for; there is no
nonce because a deposit settles once and a same-age proof cannot move the owner. `set_alpha(false)`
releases a verifier; `set_alpha(true)` puts it back, which also increments `key_set_revision` so
owners cached from unvetted proofs must prove again under supervision. Both, and
`set_alpha_attester`, bump `alpha_epoch`, which every approval signs, so outstanding approvals die
with the change (EVM `alphaEpoch`). A proof-carrying `refresh_proof` plus the attester's instruction
exceeds a legacy transaction; register the proof first and present it by reference (see Transaction
size).

**Tokens.** Both token programs are accepted: classic SPL Token and Token-2022, with any mint
extensions. Every transfer is `transfer_checked`. A transfer-hook mint's extra accounts are appended
to the instruction as remaining accounts (resolved client-side as for any transfer of that mint) and
the programs re-resolve them on-chain before each transfer. Because a Token-2022 mint may take a cut
of every transfer, the programs never trust the amount they asked for: a deposit records what reached
the vault's token account, the policy books what reached its account, and payouts and refunds carry
the mint's fee like any other transfer. Extensions that stop a transfer outright (non-transferable,
a frozen default account state, a permanent delegate moving funds, a hook that refuses) are outside
the programs' control; such a mint's deposits can neither be claimed nor refunded until the mint
authority allows it.

**Untracked funds.** SOL or tokens sent straight to a vault (no deposit record) are swept to the
cached owner by `sweep_untracked_*`, at the current policy rate; recorded deposits and the vault's
rent are never touched (`tracked_sol`, `VaultMint.tracked`).

**Transaction size and compute.** A Sunspot proof plus witness is ~750 bytes, more than a claim's
accounts leave in a legacy transaction, so `claim_*` never takes a proof inline. `register_proof`
stores it in a buffer account, `PDA(["p2id.proof.v1", registerer, sha256(payload)])`, in its own
transaction; the claim then names the buffer and its registerer as optional accounts, verifies the
stored proof, pays, and closes the buffer so the registerer gets the rent back. Such a claim is one
legacy transaction (the test suite measures it). `refresh_proof` takes the proof inline when that
fits (11 accounts, no alpha approval) or the same buffer. A proofless token claim uses ~160k compute units across the three
programs, up to ~200k for a Token-2022 mint with a transfer hook (set a 400k compute budget); a
proof-carrying one adds the verifier (a few thousand units of its own) and whatever the Groth16
verification costs, so size the compute budget from a simulation. Batching is several claim
instructions in one transaction.

**Account layout.** Every account carries a `version` and 128 (32 for deposits) reserved bytes so a
later implementation can record more without the router reallocating.

Each verifier program the factory accepts has a `VerifierConfig` account, the counterpart of the
EVM `PviumVerifier` + `PviumIdentity` pair (the verifier program itself is stateless): whether
it is allowed, the circuit version and vk hash it verifies, the P-256 keys a proof's Privy token must
have been signed by (public inputs 2-5; the proof binds the token signature to that key), and its
constraint signers. Every key handed to the factory is checked to be a point on P-256 before it is accepted, so a
mistyped or swapped key cannot sit through the notice and turn out dead. `propose_verifier` creates
the config for a new circuit version with its keys;
`activate_verifier` allows it and makes it the default after the notice; `revoke_verifier` disallows
a non-default one immediately. Per config, `propose_signer_key` / `activate_signer_key` add a key
after a 7-day notice and `remove_signer_key` retires one immediately, incrementing
`key_set_revision`; `set_alpha` releases the verifier from alpha or puts it back. A claim is checked
against the config of the verifier its deposit pins, so keys, signers and alpha mode are per circuit
version, as on EVM.

## Verifier interface

The EVM vault calls `IVerifier.verify(proof, publicInputs)` through `PviumVerifier`; the Solana
implementation does the same through the verifier interface (`crates/p2id_verifier_interface`). A
verifier is any program with one instruction,

```text
verify(proof: Vec<u8>) -> Attestation        // Anchor discriminator sha256("global:verify")[..8]
```

that fails unless `proof` is genuine and returns, as Borsh return data, what it attests:

```text
Attestation { signer_key: [u8; 64], identity_hash: [u8; 32], wallet_hash: [u8; 32], iat: i64 }
```

The implementation treats `proof` as opaque bytes and passes through, in order, the accounts the
caller appended for the verifier (remaining accounts; in `claim_token` any transfer-hook accounts
follow them). It then checks the attestation: the signer key is one the deposit's `VerifierConfig`
accepts, the identity hash is the vault's, `iat` is within bounds and not older than the newest
proof seen, and the wallet hash commits to the destination. The verifier decides whether the proof
is genuine; the implementation decides what a genuine proof is allowed to do.

`p2id_solana_verifier` is the verifier for circuit v2. Its `proof` is the Groth16 proof followed by
the 11-input public witness in gnark's serialization, exactly the bytes the Sunspot-generated
program takes; it checks the witness layout, forwards the payload unchanged and returns the
attestation read from the witness. Its two accounts are the Sunspot program and that program's
ProgramData account: the Sunspot program id is fixed at build time (`P2ID_ZK_VERIFIER`, see
`.cargo/config.toml`; the committed value is the local test backend), and the program must have no
upgrade authority, checked on every call. A new circuit is a new Sunspot program and a new build of
this verifier behind it, proposed to the factory like any other verifier.

## Build

The workspace is configured for Anchor CLI 1.1.2 and Solana CLI 3.1.10. To set up a deployable
program ID, create a program keypair locally and synchronize the declared ID:

```sh
cd solana-anchor
mkdir -p target/deploy
for p in p2id_router p2id_vault p2id_policy p2id_solana_verifier; do
  solana-keygen new -o target/deploy/$p-keypair.json --no-bip39-passphrase
done
anchor keys sync
anchor build
```

Keep the generated keypair private and out of version control. `anchor keys sync` updates the
program IDs in `Anchor.toml` and each program's `declare_id!` to match them. Build the verifier for a
real circuit with `P2ID_ZK_VERIFIER=<sunspot program id> anchor build -p p2id_solana_verifier`.
Local tests run against the workspace programs with
`P2ID_ZK_VERIFIER=CBpmjvYYEQnMkp6HeQxG5GdJXDXkZHmqb6MRFZEQpnsg anchor test --validator legacy`
to select the mock verifier explicitly; they load the
programs upgradeable and burn the upgrade authority of the implementation and both verifier
programs first, since the router admits nothing else.

### Deterministic program IDs

To derive all five program keypairs, set `SOL_PROGRAM_MASTER_SEED_SANDBOX` and
`SOL_PROGRAM_MASTER_SEED_PROD` in `.env` to separate, randomly generated 32-byte hex
seeds (64 hex characters). Back them up independently of the deployer keys. A
changed deployer does not change program IDs. Empty seeds retain the existing
file-based program IDs; setting a seed opts that environment into new IDs.

Derivation uses the pinned `ed25519-hd-key` library implementing
[SLIP-0010 Ed25519](https://github.com/satoshilabs/slips/blob/master/slip-0010.md).
Our fixed application path is `m/44'/501'/7472'/environment'/role'/release'`, with
every component hardened. `7472` is this application's namespace, not a registered
coin type. Environment indices are sandbox `0`, production `1`; role indices are
router `0`, policy `1`, implementation `2`, P2ID verifier `3`, Sunspot verifier `4`.
These indices and the path format never change for an existing derivation scheme.
`releases.json` pins scheme version `1`, the router/policy/implementation key
releases under `programKeyDerivation.releases`, and each circuit's verifier key
releases under `circuits[N].programKeyReleases`.

```sh
cd solana-anchor
yarn keys:derive sandbox          # preview public IDs; writes nothing
yarn keys:derive sandbox --sync   # prepare keys and inject IDs into source/build config
# Build the Sunspot artifacts first (preserves the derived Sunspot program keypair):
sh ../circuit/scripts/sunspot-build.sh sandbox
anchor build                    # uses the synced ZK verifier ID
yarn deploy:predict --cluster devnet
```

Use `production` in the preparation commands for production artifacts (its Sunspot
build requires ceremony keys), and `--cluster mainnet` for prediction. The `--write` option prepares only keypair files. The `--sync` option also updates
Rust `declare_id!` declarations, the selected environment's Anchor cluster tables, and
`P2ID_ZK_VERIFIER` in `.cargo/config.toml` before building. Run it whenever changing
environments or key releases; it never deploys programs. The write
command uses `SOL_PROGRAM_KEYPAIR_DIR` (default `target/deploy`) for Anchor program
keys and `SOL_ZK_VERIFIER_KEYPAIR` or the manifest path for Sunspot. `anchor keys
sync` reads `target/deploy`, so custom key directories must also be staged there
before syncing/building. It refuses conflicting keypairs before writing any files;
use a separate checkout/build directory or archive the previous build to prepare
new IDs. Build each environment separately because its program IDs differ.
Preparation prints only public IDs, never the seeds or private keys.

Deployment derives program keypairs in memory when a scoped master seed is set,
checks Anchor IDs against the compiled IDL, and supplies temporary private key files
to the CLI. `verify-proof` also resolves the circuit's derived Sunspot ID. The
Sunspot program does not embed its own id, so an existing `pvium_identity.so` deploys
unchanged under the derived keypair; only the P2ID verifier is rebuilt, for that id.
Deriving a keypair does not replace the Groth16 trusted setup or its proving/verifying
keys: never re-run `sunspot setup` for a key that proofs or a deployment already use.

To fix an immutable release, append/version its source and increment the affected
program's key release for the new manifest entry, then prepare and rebuild that
release. Never change a shipped release's recorded derivation or rebuild it under
the old ID. Old manifests and backed-up seeds reproduce old IDs; new program IDs
still require the protocol's registration, notice or migration process.

## Deploy

`scripts/deploy.ts` deploys the stack to a cluster and brings it up to the current release, the way
the EVM deploy script does for a chain:

```sh
cp .env.example .env            # fill in the environment's values
yarn deploy:predict --cluster devnet   # addresses only, nothing sent
yarn deploy --cluster devnet           # sandbox
yarn deploy --cluster mainnet          # production
yarn deploy:plan --cluster mainnet     # read the cluster, write the authority instructions, send nothing
```

Set `SOL_DEPLOYER_PRIVATE_KEY_SANDBOX` (devnet/localnet) and
`SOL_DEPLOYER_PRIVATE_KEY_PROD` (mainnet) in `.env` to separate base58 private keys
(32-byte seeds or 64-byte secret keys), or 32-byte hex seeds. Each command requires
its environment's key and derives the public key automatically. Shared keys and
local CLI wallets are never used as fallbacks. Deployment creates a temporary
wallet file for the Solana CLI with owner-only permissions and removes it when
the command finishes.

The cluster decides the environment (`deploy.config.ts`: devnet and a local validator are
`sandbox`, mainnet is `production`), and every environment-specific setting is read with that suffix
from `.env`: the Privy keys (shared with the EVM stack, so they fall back to `ethereum/.env`), the
authority (a Squads vault) and the alpha attester. `releases.json` says what the stack is built
from: the circuit version the factory is initialized with and the sha256 of its Sunspot verifying
key, the policy rate, the program crates, the Sunspot artifact, and the authority settings every
cluster of the environment should have now (alpha attester, constraint signers to add or retire).

A run deploys the Sunspot program and burns its upgrade authority, builds the P2ID verifier with
`P2ID_ZK_VERIFIER` set to it and checks on-chain that the deployed verifier fronts exactly that
program, deploys the policy, router and implementation programs, and initializes the policy and
factory. Both verifiers and the implementation have their upgrade authorities burned on every
cluster, as required by the on-chain immutability checks. The router and policy authorities are
burned only on `--cluster mainnet`.
On devnet and localnet the router remains controlled by the deployer; the policy authority is
transferred to `SOL_AUTHORITY_SANDBOX`. The legacy `--finalize-policy` flag cannot enable policy
burns outside mainnet.
Before reporting success, the script checks the required programs are immutable and retained
authorities match their expected controllers. All authorities are recorded in the deployment
record. `--plan` records current state without enforcing completion and sends no transactions.
Burned programs cannot be upgraded in place; a later verifier or implementation requires a new
program ID and registration through the router.
Policy and factory administrative instructions are sent when the deployer is the authority; otherwise they are written to
`deployments/squads/` as unsigned instructions to import into Squads. Every step is skipped when the
cluster already has it, so the command is re-runnable and is how a cluster picks up a new release.
Each run writes `deployments/<scheme>.<environment>.<cluster>.json` (program ids, PDAs, params
hash, configuration, live status), and refuses a configuration whose factory PDA differs from an
earlier record of the same environment. A local validator requires `SOL_DEPLOYER_PRIVATE_KEY_SANDBOX`; other unset values default to
the deployer as authority and attester, a built-in Privy key and, when no sandbox Sunspot artifact has
been built, the test verifier as the ZK backend; nothing is recorded.

### The Sunspot verifier

The ZK backend of each environment is a Groth16 verifier program generated by
[Sunspot](https://github.com/reilabs/sunspot) from the circuit, with the verifying key compiled in.
`circuit/scripts/` builds it; the deploy script only deploys what those scripts produce:

```sh
circuit/scripts/sunspot-install.sh         # Sunspot + Reilabs' trusted-setup, pinned, into .tools/
source .tools/env.sh
circuit/scripts/sunspot-build.sh sandbox   # keys from Sunspot's own setup: devnet and local only
circuit/scripts/sunspot-build.sh production  # keys from the ceremony (below)
```

`sunspot-build.sh` compiles the circuit with the Noir release Sunspot reads (separately from the EVM
artifact), turns the ACIR into a gnark constraint system, makes or takes the environment's proving and
verifying keys, and builds the verifier program and its keypair into
`circuit/target/sunspot/<environment>/`, where `releases.json` points. The two environments have
different keys, so different programs and vkHashes; the P2ID verifier crate is built once per cluster
against the environment's program id. Groth16 needs a circuit-specific trusted setup: Sunspot's
single-party setup is fine for devnet but production keys come from a multi-party phase-2 ceremony
run with `circuit/scripts/sunspot-ceremony.sh` (phase 1 is imported from the Perpetual Powers of Tau;
the script downloads the file the circuit's size needs, initializes phase 2, verifies each
contribution and extracts the keys, writing a transcript to publish). The keys are sound as long as
one contributor destroyed their randomness.

To check a deployed verifier with a real proof, make one with `circuit/scripts/sunspot-prove.sh
<environment>` (the sample token, or `--jwt/--type/--value/--wallet`) and run
`yarn verify-proof --cluster <cluster> --proof circuit/target/sunspot/<environment>/proofs/<name>.json`:
it simulates the P2ID verifier's `verify` on the cluster and compares the attestation it returns
with the wallet and hashes the proof should carry. The HTTP prover proves for Solana with the same
artifacts (`SUNSPOT_*` in its `.env`).
