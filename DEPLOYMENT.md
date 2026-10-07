# Deployment runbook

Order matters: **decide the configuration → predict → record → deploy contracts → prover → SDK →
API**. Each step says how to confirm it worked. Do a full pass on the sandbox environment before
production.

## Environments

Pvium has two environments, and each is a separate stack at separate addresses:

| Environment | Privy app | Networks (`deploy.config.ts`) | Settings in `.env` |
| --- | --- | --- | --- |
| `sandbox` | `cmhc6t92u001tju0cxkxg34on` | `baseSepolia` | `*_SANDBOX` |
| `production` | `cmjzq9okg01kwjm0cq4b0xs74` | `base`, `bsc` | `*_PROD` |

The network you pass picks the environment, and the script reads only that environment's values:
its Privy JWKS, owner and attester. There is no way for a testnet run to pick up production
settings, and `P2ID_ENV` cannot override a network's configured environment. Within an
environment every chain gets the same configuration and therefore the same addresses. Adding a
chain is one line in `deploy.config.ts`.

Three facts to keep in mind throughout:

- **The contract configuration is permanent for a scheme and environment.** The owner, the Privy
  key set, the initial attester, delays and refund windows are constructor values; with deterministic
  deployment they decide the factory address, and the factory address decides every identity's
  P2ID address. Changing any of them later means a new stack at new addresses. (Attesters can be
  added and revoked afterwards by the verifier's owner; only the initial one is part of the address.)
- **The Privy key set is read from the JWKS at deployment time.** Privy publishes two keys per app
  and may sign with either, so `PviumIdentity` accepts the whole set. If Privy's JWKS changes
  between two chains' deployments, the second would get different addresses; the script detects
  that and refuses (see step 4). Keys Privy adds later are proposed by the owner and accepted
  after 7 days' public notice (`proposeSignerKey` → `activateSignerKey`), with no redeployment.
- **Proofs made before the circuit's public inputs changed (the `recipient` input became the checked
  `wallet`) no longer verify.** Nothing was deployed, so the circuit is still version 1, but any
  attestation stored from the earlier build has a different verification key and must be regenerated (step 7).

## 0. Prerequisites

- Node 22.13+ and yarn; `nargo 1.0.0-beta.26` and `bb 5.0.0` only if you rebuild
  the circuit (not needed to deploy what is committed).
- All suites green on the commit you deploy: `contracts` (`yarn test`), `sdks/node` (both packages)
  (`yarn test`), `http-prover` (`yarn test`), `circuit` (`sh test/e2e.sh && sh test/adversarial.sh`).
- A **Safe that exists at the same address on every target chain**, to own the factory registry.
  Create it first (Safe's deterministic deployment gives the same address everywhere when the
  owners, threshold and salt nonce match). An EOA works mechanically but is a single key holding
  the verifier registry.
- The two Privy JWKS URLs (already filled in `.env.example`). A saved `jwks.json` path works too,
  if you want to pin exactly what was deployed or the endpoint is unavailable.
- A funded deployer account on each chain. It receives no privileges and does not affect addresses.

## Trying it locally first

No `.env` is needed on a local chain; unset values default to the sandbox Privy JWKS, the first
local account as owner, and no attester.

```sh
yarn hardhat run scripts/deploy-deterministic.ts --network hardhat     # throwaway: gone when it exits
yarn hardhat node                                                      # or keep one running…
yarn hardhat run scripts/deploy-deterministic.ts --network localhost   # …and deploy to it
```

## 1. Configure

```sh
cd contracts
cp .env.example .env      # git-ignored
```

Fill in, per environment, `OWNER_SANDBOX` / `OWNER_PROD` (the Safe), `ATTESTER_SANDBOX` /
`ATTESTER_PROD` (the address whose EIP-712 signatures satisfy screening constraints, or `none`),
optional `ALPHA_ATTESTER_SANDBOX` / `ALPHA_ATTESTER_PROD` (the factory alpha signer;
omitted or blank uses that environment's owner), and the deployer key. Set both attester
variables to the same address if the roles should share a key. The factory alpha signer
is a single address; constraint signers remain a verifier-managed set. Signer changes
are immediate. The JWKS URLs are prefilled. Change the delays only if the defaults (7-day
policy-change notice, 1–90 day refund windows) are not what you want. A default-verifier change
always needs 14 days' notice; that is fixed in the factory.

## 2. Predict the addresses (no transactions)

```sh
PREDICT=1 yarn hardhat run scripts/deploy-deterministic.ts --network baseSepolia   # sandbox
PREDICT=1 P2ID_ENV=production yarn hardhat run scripts/deploy-deterministic.ts   # production, offline
```

Prints the environment, the Privy keys it fetched (with their `kid`), the configuration, and the
seven addresses it will have on every chain of that environment. Nothing is sent.

## 3. Record the factory; the production one freezes the scheme

The deploy script records the factory itself: after a successful run whose wiring checks pass, if
`sdks/node/p2id-core/src/p2id.json` has no factory yet for that environment under the current
scheme (`pvium.vault.v1`), it writes the deployed address into `factories.sandbox` or
`factories.production`. Rebuild the SDK (`yarn build` in `sdks/node`) and commit the file; pushing
then publishes an SDK that derives against it. (Recording the predicted address by hand before
deploying is equivalent, and the script refuses to deploy if its configuration would produce a
different one.)

Recording the sandbox factory freezes nothing: while `production` is `null` the vault proxy may
still change, and the deploy script refreshes `vaultInitCodeHash` from the build it deploys
(dropping a sandbox factory recorded under the old hash, then recording the new one);
`node scripts/embed-p2id.mjs --update` in `sdks/node/p2id-core` does the same by hand. From the commit that records the production factory, a
change to the proxy creation code fails the init-code-hash consistency check until a new scheme
(a new scheme entry with its own salt name) is added. Changes to the factory or its embedded base
implementation also change the predicted factory address. Deploying a standalone registered vault
implementation for an existing factory does not change its vault addresses. The deploy script
refuses to run if its configuration no longer produces the recorded factory.

(Deploying to one testnet first and recording the address from its output is equivalent.)

## 4. Deploy the contracts, once per chain

```sh
yarn hardhat run scripts/deploy-deterministic.ts --network baseSepolia   # sandbox
yarn hardhat run scripts/deploy-deterministic.ts --network base          # production
yarn hardhat run scripts/deploy-deterministic.ts --network bsc           # production, same addresses as base
```

The script

1. requires the deterministic deployment proxy `0x4e59b44847b379578588920cA78FbF26c0B4956C` on the
   chain (it is on Base, Ethereum, Optimism, Arbitrum, Polygon and most others; if it is missing,
   stop: deploy it first or addresses will not match),
2. deploys `RelationsLib`, `ZKTranscriptLib`, `PviumZKVerifier`, `PviumIdentity`, `PviumVerifier`,
   `PviumP2IDPolicy` (the launch policy: allowlist containing that verifier, no fee) and
   `PviumP2IdVaultFactory`, skipping any that already exist, so it is safe to re-run after an
   interruption,
3. reads everything back and checks the wiring: code at every address, every Privy key, the
   circuit version, pinned vkHash from circuit/version.json and the owner in `PviumIdentity`, the attester in `PviumVerifier`, the policy's owner and
   allowlist, and the factory's owner, policy, default verifier, namespace, delays, refund bounds,
   base implementation address/code/factory binding/registration, and vault init-code hash against `p2id.json`,
4. calls `policy.setFactory(factory)` when the deployer is the owner; otherwise prints the calldata
   for the owner (a Safe) to send. Until it is sent the policy refuses every fee and recipients are
   paid in full, so nothing breaks if it waits, but it must be done before a fee policy is activated,
5. writes `contracts/deployments/<scheme>.<environment>.<chainId>.json`, including the Privy keys
   and their `kid`s. Commit it.

Before sending anything it compares its predicted factory with `p2id.json` and with every earlier
deployment record of the same scheme and environment, and stops if they differ, naming the likely
cause (for example, the Privy JWKS changed since the first chain was deployed).

**Confirm:** it ends with `wiring checks passed (<environment>)`, and `factory` equals the recorded
one on every chain of that environment. Expect roughly 9–10M gas in total; the Honk verifier is most of it.

Verify sources on the explorer (optional, recommended). `scripts/verify-deployments.ts` reads the
chain's deployment record, asks the explorer which addresses are already verified, and submits
the rest with the constructor arguments the record holds. One `ETHERSCAN_API_KEY` in `.env`
covers every chain (Etherscan V2 API):

```sh
yarn verify --network base                                   # every deployments/*.<chainId>.json for the chain
DEPLOYMENT=deployments/pvium.vault.v1.production.8453.json yarn verify --network base
VAULTS=0x…,0x… yarn verify --network bsc                     # vaults the factory has deployed (no constructor args)
DRY_RUN=1 yarn verify --network base                         # print the plan, call nothing
```

Run it from the commit that produced the record: the explorer compares the compiled bytecode with
what is on chain, so a record from an older build verifies only with that build checked out.

Nothing needs to be handed over afterwards: the factory and the launch policy were given `OWNER`
at construction, and no other contract has an admin.

## 5. Deploy the prover

The prover must serve the circuit version the contracts and SDK verify (currently 1).

- **Railway:** redeploy from the commit. The Dockerfile ships `http-prover/circuit/` as committed.
- **VPS workflow:** tag `prover-vX.Y.Z` on that commit, or run "Deploy http-prover" manually from
  `main`. It rebuilds the circuit and fails if the verification key does not match
  `circuit/version.json`. The VPS needs glibc ≥ 2.34 for `bb`.

**Confirm:** `GET /healthz` reports `circuitVersion: 1` and `vkSha256` starting `0x1c7991`. Then
request one attestation with a real token and verify it with the SDK built from this commit.

## 6. Publish the SDK

```sh
cd sdks/node
yarn install && yarn test   # both packages: embeds the P2ID schemes and the vk, checks them against the build
# publish core first: the verifier depends on it
(cd p2id-core && npm version <x.y.z> && npm publish --access public)
(cd p2id-verifier && npm version <x.y.z> && npm publish --access public)
```

**Confirm:** `p2idAddress({ identityType: 'email', identityValue: … })` returns the same address as
`factory.vaultFor(identityHash)` on a production chain, and adding `environment: 'sandbox'` matches
the sandbox factory on the testnet.

## 7. Point the API at it

- Set the prover URL and token (`service.prover.*`) if they changed, and upgrade `@pvium/p2id-verifier` (and `@pvium/p2id-core` where addresses are derived).
- Mark every user `proofSynced: false` so the worker regenerates attestations under the current
  verification key. Until a user is regenerated, resolution for them has no valid attestation.
- The worker must prove the wallet the user has chosen to receive to, not a fixed index: the
  newest proof presented to a vault sets its owner, so proving another wallet later would move it.

## 8. First live check

On a testnet, with a test identity you control:

1. `p2idAddress(...)` → send a small ERC-20 amount to it.
2. `factory.deploy(identityHash)`.
3. `vault.refreshProofAndSweep(pviumVerifier, abi.encode(proof, publicInputs), token, 0)`.
   The linked wallet receives the amount, and `OwnerRefreshed` is emitted.
4. Fund through `factory.fund(...)` with a short refund window and confirm `refund` works after it.

## Changing things later

| Change | What to do | Addresses |
| --- | --- | --- |
| Privy adds or retires a key | `PviumIdentity.proposeSignerKey(x, y, jwksUrl, kid)` → wait 7 days → `activateSignerKey`; `removeSignerKey` for a retired one, at once. Existing deposits stay claimable | unchanged |
| A new circuit version | Deploy a new `PviumIdentity` + `PviumVerifier`, `policy.approveVerifier` it (payers can opt in with `fundWith` at once), then `proposeDefaultVerifier` → wait 14 days → `activateDefaultVerifier`. Owners need a fresh proof under the new default before direct transfers follow | unchanged |
| New attester, or turning screening on | `PviumVerifier.setConstraintSigner(attester, true)` from the verifier's owner; revoke old ones the same way. No new deployment | unchanged |
| A third party's verifier | `policy.approveVerifier`; payers opt in with `fundWith` | unchanged |
| A verifier is found unsafe | `policy.approveVerifier(v, false)`: claims under it freeze, refunds still work | unchanged |
| Protocol fees, or permissionless verifier registration (staking) | Deploy a new `IP2IDPolicy`, then `factory.proposePolicy` → wait the delay → `activatePolicy`. Fees stay capped at the factory's fixed `MAX_FEE_BPS` (1%) and apply only to deposits made after the switch; the new policy's `collectFee` receives each fee at claim time, with the claimer's address, and decides who gets it (e.g. a verifier operator's share, a claim relayer's reward) | unchanged |
| Vault, factory or launch-policy code changes before release | While no factory is recorded in `p2id.json`: rebuild, `embed-p2id.mjs --update`, deploy again (a superseded testnet record in `deployments/` must be moved aside first) | new addresses for the changed contracts |
| Compatible vault implementation for an existing factory | `IMPLEMENTATION=<Contract> yarn implementation --network <chain>`: runs the `yarn layout` checks (storage layout against `storage/P2IDVault.layout.json`, the owner-proof hook, no `delegatecall`/`selfdestruct`, no proxy-reserved selectors), deploys through `factory.deployVaultImplementation` at the same CREATE2 address on every chain, and proposes it (`MAKE_DEFAULT=1` to also make new vaults start on it; prints calldata when the owner is a multisig); after 14 days `REGISTER=1 yarn implementation`. Verify it with `IMPLEMENTATIONS=src/X.sol:X@0x… yarn verify`. Each vault owner opts in with `upgradeTo` and an identity proof | vault addresses unchanged; new vaults use the current default |
| Revoke an implementation | `revokeImplementation` removes it as an upgrade target immediately; installed copies continue executing. The original implementation and current default cannot be revoked | unchanged |
| Factory or proxy code changes after release | Add a new scheme entry to `p2id.json`, deploy the new stack and release the SDK. Existing vaults remain on their original factory/proxy | **new scheme, new addresses** |


## Deterministic vault implementations

This workflow requires a factory deployed with `deployVaultImplementation`. Existing deployed
factories cannot acquire this API: the factory itself is not upgradeable. Changing the factory
bytecode changes the address predicted by the stack deployment script. Existing deployment records
and SDK factory addresses must be handled as a separate rollout; this workflow does not overwrite them.

The factory owner calls `deployVaultImplementation(creationCode, makeDefault)`. Creation code
includes constructor arguments. CREATE2 uses the factory as deployer and
`keccak256("pvium.vault.implementation.v1")` as salt. The bytecode hash determines the address;
the default flag does not. Solidity requires the boolean argument; the script defaults it to false.

Deployment and proposal are atomic. A fresh implementation is not registered immediately.
After 14 days, the owner calls `registerImplementation()`. With `makeDefault=true`, that call
also sets the implementation used when future vault proxies are deployed. Existing vaults keep
their implementation until their owners authorize an upgrade. Counterfactual vaults funded before
deployment receive whichever default is active when they are deployed.

From `contracts/`, with the configured network and owner signer:

```sh
# Review a plan; writes owner transaction calldata without broadcasting.
FACTORY=0x... CANDIDATE=src/MyVaultV2.sol:MyVaultV2 MAKE_DEFAULT=true OUT=/tmp/vault-v2-plan.json yarn deploy:implementation --network baseSepolia

# Deploy through the factory and immediately propose registration.
FACTORY=0x... CANDIDATE=src/MyVaultV2.sol:MyVaultV2 MAKE_DEFAULT=true EXECUTE=1 yarn deploy:implementation --network baseSepolia

# Once the on-chain ETA is reached, activate that exact candidate and flag.
FACTORY=0x... CANDIDATE=src/MyVaultV2.sol:MyVaultV2 MAKE_DEFAULT=true ACTION=activate EXECUTE=1 yarn deploy:implementation --network baseSepolia
```

The script supports implementations with `constructor(address factory)`, checks the candidate
against the committed original storage layout, predicts the address and simulates the owner call.
For multisig ownership, submit the plan's `to` and `data` from the owner account.
`OUT` refuses to overwrite an existing file. Keep the same source, compiler settings and constructor
arguments for activation. Verify the deployed implementation on the explorer with its factory
constructor argument.

Repeating an identical pending deployment request reuses the code and preserves its ETA.
A different pending proposal must be cancelled before this deployment API can proceed.
Repeating an already registered opt-in deployment is a no-op. Changing it to the default starts
a new 14-day proposal. `proposeDefaultImplementation(address)` can also select an already
registered implementation, including the original fallback, after the same delay.
Manual `proposeImplementation(address)` replaces a pending proposal and clears its default flag.

The factory checks code presence and raw factory binding on deterministic deployment and default
activation; it cannot prove storage compatibility or safe delegatecall behavior. Review each
candidate against every implementation users may upgrade from, including appended storage.
The original fallback preserves only its known fields and may not interpret data introduced by
later versions. No live deployment is performed by the dry-run command.
