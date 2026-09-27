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

- Node 22.13+ and yarn; `nargo 1.0.0-beta.22` and `bb 5.0.0-nightly.20260522` only if you rebuild
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
and the deployer key. The JWKS URLs are prefilled. Change the delays only if the defaults (7-day
policy-change notice, 1–90 day refund windows) are not what you want. A default-verifier change
always needs 14 days' notice; that is fixed in the factory.

## 2. Predict the addresses (no transactions)

```sh
PREDICT=1 yarn hardhat run scripts/deploy-deterministic.ts --network baseSepolia   # sandbox
PREDICT=1 P2ID_ENV=production yarn hardhat run scripts/deploy-deterministic.ts   # production, offline
```

Prints the environment, the Privy keys it fetched (with their `kid`), the configuration, and the
seven addresses it will have on every chain of that environment. Nothing is sent.

## 3. Record the factory, which freezes the scheme

Put each predicted `factory` into `sdks/node/p2id-core/src/p2id.json` under the current scheme
(`p2id.vault.v2`), in `factories.sandbox` and `factories.production`, and commit. Preserve the
existing `p2id.vault.v1` entry and its deployment records.

From this commit on, a change to `P2IDVault` fails the SDK build and the contract tests until a new
scheme (`p2id.vault.v3`) is added; that is the guard against silently moving addresses. The deploy
script also refuses to run if its configuration no longer produces the recorded factory.

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
   circuit version and the owner in `PviumIdentity`, the attester in `PviumVerifier`, the policy's owner and
   allowlist, and the factory's owner, policy, default verifier, namespace, delay and vault
   init-code hash against `p2id.json`,
4. writes `contracts/deployments/<scheme>.<environment>.<chainId>.json`, including the Privy keys
   and their `kid`s. Commit it.

Before sending anything it compares its predicted factory with `p2id.json` and with every earlier
deployment record of the same scheme and environment, and stops if they differ, naming the likely
cause (for example, the Privy JWKS changed since the first chain was deployed).

**Confirm:** it ends with `wiring checks passed (<environment>)`, and `factory` equals the recorded
one on every chain of that environment. Expect roughly 9–10M gas in total; the Honk verifier is most of it.

Verify sources on the explorer (optional, recommended). Constructor arguments are in the
deployment record:

```sh
yarn hardhat verify --network base <pviumIdentity> --constructor-args identity-args.js   # [zkVerifier, circuitVersion, owner, [x…], [y…]] sorted as in the record
yarn hardhat verify --network base <pviumVerifier> <pviumIdentity> <owner> '[<attester>]'   # '[]' when deployed with none
yarn hardhat verify --network base <factory> <owner> <keccak256(scheme)> <policy> <pviumVerifier> <policyChangeDelay> <minRefundWindow> <maxRefundWindow>
yarn hardhat verify --network base <zkVerifier> --libraries libraries.js   # { RelationsLib, ZKTranscriptLib }
```

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
| Protocol fees, or permissionless verifier registration (staking) | Deploy a new `IP2IDPolicy`, then `factory.proposePolicy` → wait the delay → `activatePolicy`. Fees stay capped at 1% by the vault and apply only to deposits made after the switch; the new policy's `distributeFee` decides who receives them (e.g. a verifier operator's share) | unchanged |
| Vault, factory or launch-policy code changes before release | While no factory is recorded in `p2id.json`: rebuild, `embed-p2id.mjs --update`, deploy again (a superseded testnet record in `deployments/` must be moved aside first) | new addresses for the changed contracts |
| Vault or factory code changes after release | Add `p2id.vault.v(N+1)` to `p2id.json`, deploy that stack, release the SDK; the old scheme stays derivable and claimable | **new scheme, new addresses** |
