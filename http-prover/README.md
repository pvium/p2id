# http-prover

Generate identity attestations from Privy-signed tokens. The service proves a linked identity
and, when supplied, a linked wallet. Verify the output with `@pvium/p2id-verifier` or
`PviumIdentity.sol`.

The Express API uses a shared bearer secret. Circuit solving runs in a worker thread with
`noir_js`. Ethereum proofs use the native `bb` binary; Solana proofs use the Sunspot binary to
produce Groth16 proofs.

## API

`POST /attestations` — `Authorization: Bearer <AUTH_TOKEN>`

```json
{ "identityType": "email", "identityValue": "you@example.com", "jwt": "<privy identity token>", "wallet": "0x…", "version": 1, "network": "ethereum" }
```

`network` accepts `ethereum` or `solana` (case-insensitive). It defaults to `ethereum` for
existing callers. Ethereum `publicInputs` contains 11 fields of 32 bytes each. For Solana,
`publicInputs` is the base64 encoding of Sunspot's complete `.pw` public-witness file, and
`publicWitness` is an alias of the same bytes for Solana verifiers that expect that field alongside
the Groth16 `proof`. Solana responses omit `vkHash`, which identifies the Ethereum Barretenberg
verification key.

Response for Ethereum, about 15 KB:

```json
{ "proof": "<base64>", "publicInputs": "<base64>", "wallet": "0x…", "identityType": "email", "issuedAt": 1789240094,
  "network": "ethereum", "circuitVersion": 1, "vkHash": "0x…", "kid": "…" }
```

Solana responses include `"network": "solana"` and carry the base64-encoded Sunspot `.proof` and
`.pw` files in `proof`, `publicInputs` and `publicWitness`. The Ethereum verifier SDK does not
verify this proof format.

`version` defaults to the service's circuit version. Each instance serves one version and
returns 400 for a different requested version. Store `circuitVersion` with the attestation and
use the matching verifier release or contract. `issuedAt` is the token's issue time, not the
time the proof was generated.

Synchronous responses:

| Status | Meaning |
| --- | --- |
| 200 | attestation generated |
| 400 | malformed body, unsupported network, identity or wallet not linked in the token, token too large |
| 401 | bad secret, or the token is not signed by a trusted Privy key |
| 413 | body over 64 KB |
| 500 | proof generation failed |
| 503 | concurrency and queue limits reached; retry after 10 seconds |

The service checks the token's signature before circuit solving or proof generation.

### Asynchronous mode

Add `"callbackUrl": "https://your-backend/hooks/attestation?secret=…"` to receive
`202 { jobId, status: "queued" }`. The service then POSTs the result to that URL:

```json
{ "jobId": "…", "status": "ok", "attestation": { … }, "identityType": "email", "identityValue": "…", "wallet": "0x…" }
{ "jobId": "…", "status": "error", "error": "no linked account with …", "identityType": "email", "identityValue": "…", "wallet": "0x…" }
```

Results are stored in a SQLite outbox (`DB_PATH`, using `node:sqlite`) before delivery. Pending
deliveries resume after a restart when the database is retained. Queued and proving jobs remain
in memory until a result is stored. Synchronous results are not stored.

Failed deliveries retry after 1 min, 5 min, 30 min, 2 h, then every 6 h. A 2xx response completes
delivery. A 4xx response ends retries, except for 408 and 429. Failed attempts after 48 hours also
end retries. `GET /jobs/:id` returns the delivery state and result.

Callbacks are unsigned. To authenticate delivery, include a secret in the callback URL and
check it at the receiver. Verify the attestation separately. URLs must use HTTPS unless
`ALLOW_HTTP_CALLBACKS=true`. Use callbacks when the caller should not wait for proof generation.

### Back-pressure

`MAX_CONCURRENCY` limits active proofs; `MAX_QUEUE` limits requests waiting for a slot. When both
limits are reached, new work receives 503 with a JSON error and `Retry-After: 10`.
`/healthz` reports `inFlight` and `queued`. Limits apply per process; the PM2 configuration runs
one instance.

For a 502 or 503 without the service's JSON error, check proxy logs, process restarts and memory
usage. The response alone does not establish whether the process ran out of memory.

### Repeated requests

A callback request matching an active job's network, identity type, normalized identity value,
wallet and callback URL returns `202 { jobId, status: "proving", deduplicated: true }`, including at
capacity. It does not start another proof. The JWT is excluded from this key: submitting a fresher
token can return the existing job's proof. A different callback URL starts a separate job.
Once the result is stored, a repeated request starts a new job.

### Status endpoints

`GET /healthz` — unauthenticated liveness check; reports `circuitVersion`, `vkHash`, concurrency
and queue counts and limits, and outbox counts by status.

`GET /jobs/:id` — bearer authentication required. Returns `proving` for an active job; stored
results include `pending`, `delivered` or `failed` delivery status, attempts and the last error.
Unknown job IDs return 404.

The service checks the artifacts against `circuit/version.json` at startup: the verification key's
SHA-256 hash, and the circuit's nargo `hash` (`circuitHash`; `sunspotCircuitHash` for the Sunspot
ACIR when Solana is enabled). The circuit check exists because recompiling the same Noir source does
not reproduce the committed artifact (the libraries come from git with no lock file), and a rebuilt
circuit would pass the vk check and then prove against keys for a different circuit, which the
on-chain verifiers reject. A rebuilt circuit is a new circuit version, never a refresh of the
committed one. Ethereum requests also check that `bb` exactly matches the version recorded for the circuit before
proving. This check is intentionally not version-agnostic: the Ethereum proof backend, verification
key and SDK must use compatible Barretenberg builds. Solana proving, when enabled (see below), is
checked the same way at startup: the keys are fetched or hashed, the resident prover is started and
has to load the key before the service listens, and `/healthz` answers 503 while it is not ready.
Every attestation carries the `vkHash` of the key it is for: Ethereum, the Barretenberg vk;
Solana, the Sunspot vk as deployed in the on-chain program (the factory's vkHash), which tells a
sandbox proof from a production one. Both backends check that the proof's `iat` is the token's.

## Running

Run these commands from `http-prover/`. The repository includes the compiled circuit,
verification key, and version metadata; startup extracts the compressed circuit automatically.
You do not need to compile or copy circuit artifacts to run the committed build.

```sh
cd http-prover
yarn install
cp .env.example .env && $EDITOR .env
yarn build && yarn start        # node --env-file=.env dist/server.js
```

Each successful request returns a JSON attestation. Ethereum uses Barretenberg's proof and
11-field public inputs. Solana returns Sunspot's `.proof` bytes in `proof` and the complete `.pw`
bytes (base64-encoded) in both `publicInputs` and `publicWitness`. Stop the server with Ctrl+C.

The local `.env.example` paths assume you are running from `http-prover/`. Its `BB_BIN` example is
for Apple Silicon macOS; change the architecture directory for another platform, or point it to
an absolute path to Barretenberg 5.0.0. If `yarn` is not on PATH, run the package commands with
`corepack yarn`.

For a production-style build instead of the development server, run `yarn build` followed by
`yarn start`. The repository includes the compressed compiled circuit, verification key, and
version metadata; startup extracts the compressed circuit automatically. You do not need to
recompile the circuit for the Ethereum demo.

### Solana

Solana proofs are Groth16 proofs made by [Sunspot](https://github.com/reilabs/sunspot) from the same
circuit compiled with the Noir release Sunspot reads. The service solves the witness with noir_js
from `circuit/pvium_identity.sunspot.json` (committed gzipped, inflated at startup like the Ethereum
circuit; `yarn sync` refreshes it from `circuit/scripts/sunspot-build.sh`'s output) and proves with
`sunspotd`, a small resident prover (`sunspotd/main.go`, built inside the pinned Sunspot module by
`circuit/scripts/sunspot-install.sh` and by the Docker image). It loads the ACIR, the constraint
system and the proving key once, at startup, then proves on request over stdin/stdout. The proving
key is 2.6 GB and takes about 30 s to load, so this is the difference between about 11 s and about
70 s per proof, and between one resident copy of the key and one per request. Memory: about 8 GB
for the resident prover while proving.

The constraint system (276 MB) is not shipped: the first start compiles it from the ACIR (about
15 s, deterministic) and writes it next to the proving key, named after the ACIR's hash
(`pvium_identity.<hash>.ccs`), and later starts read it in a couple of seconds. A changed ACIR gets a
different name and is recompiled; deleting the file has the same effect. `SUNSPOT_CCS_PATH` names
the file explicitly, for instance `circuit/target/sunspot/pvium_identity.ccs` from the build script
when running locally.

Keys are per environment. Sandbox keys come from Sunspot's single-party setup and are only for
devnet and local use; production keys come from the phase-2 ceremony
(`circuit/scripts/sunspot-ceremony.sh`). Neither is in the repository or the image: locally,
`SUNSPOT_PK_PATH` and `SUNSPOT_VK_PATH` point at what `sunspot-build.sh <environment>` wrote; a
deployment sets `SUNSPOT_PK_URL` and `SUNSPOT_PK_SHA256` (and the same for the vk) and the service
fetches the key onto its data volume once and checks its hash on every start. A proving key from the
wrong setup would mint proofs the deployed verifier rejects, which is what the hash check and the
`vkHash` in every attestation are for. Solana is off, and `network: "solana"` requests are refused
with 400, until a proving key is configured.

```sh
cd ..
circuit/scripts/sunspot-install.sh && source .tools/env.sh
circuit/scripts/sunspot-build.sh sandbox
cd http-prover && yarn sync          # refresh circuit/pvium_identity.sunspot.json.gz (never the Ethereum artifact: that needs --evm and a new circuit version)
# .env: SUNSPOTD_BIN=$SUNSPOTD_BIN, SUNSPOT_PK_PATH / SUNSPOT_VK_PATH from sunspot-build.sh's output
yarn dev
```

Then send the normal request with `"network": "solana"` and the Solana wallet address to bind. The
response's `proof` and `publicWitness` are exactly the bytes the on-chain verifier takes;
`solana-anchor`'s `yarn verify-proof` checks such a response against a deployed verifier.
