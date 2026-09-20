# http-prover

Generate identity attestations from Privy-signed tokens. The service proves a linked identity
and, when supplied, a linked wallet. Verify the output with `@pvium/p2id-verifier` or
`PviumIdentity.sol`.

The Express API uses a shared bearer secret. Circuit solving runs in a worker thread with
`noir_js`; proof generation uses the native `bb` binary.

## API

`POST /attestations` — `Authorization: Bearer <AUTH_TOKEN>`

```json
{ "identityType": "email", "identityValue": "you@example.com", "jwt": "<privy identity token>", "wallet": "0x…", "version": 1 }
```

Response, about 15 KB:

```json
{ "proof": "<base64>", "publicInputs": "<base64>", "wallet": "0x…", "identityType": "email", "issuedAt": 1789240094,
  "circuitVersion": 1, "vkHash": "0x…", "kid": "…" }
```

`version` defaults to the service's circuit version. Each instance serves one version and
returns 400 for a different requested version. Store `circuitVersion` with the attestation and
use the matching verifier release or contract. `issuedAt` is the token's issue time, not the
time the proof was generated.

Synchronous responses:

| Status | Meaning |
| --- | --- |
| 200 | attestation generated |
| 400 | malformed body, identity or wallet not linked in the token, token too large |
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

A callback request matching an active job's identity type, normalized identity value, wallet and
callback URL returns `202 { jobId, status: "proving", deduplicated: true }`, including at
capacity. It does not start another proof. The JWT is excluded from this key: submitting a fresher
token can return the existing job's proof. A different callback URL starts a separate job.
Once the result is stored, a repeated request starts a new job.

### Status endpoints

`GET /healthz` — unauthenticated liveness check; reports `circuitVersion`, `vkHash`, concurrency
and queue counts and limits, and outbox counts by status.

`GET /jobs/:id` — bearer authentication required. Returns `proving` for an active job; stored
results include `pending`, `delivered` or `failed` delivery status, attempts and the last error.
Unknown job IDs return 404.

Startup requires the pinned `bb` version and checks the verification key's SHA-256 hash against
`circuit/version.json`.

## Running

```sh
yarn install
yarn sync          # copy circuit/target/pvium_identity.json and the vk from ../circuit
cp .env.example .env && $EDITOR .env
yarn build && yarn start        # node --env-file=.env dist/server.js
```

The Linux `bb` binary requires a 64-bit system with glibc 2.34 or newer, such as Ubuntu 22.04+
or Debian 12+. Use Node 22.13+ for `node:sqlite` and the pinned `bb` version
`5.0.0-nightly.20260522`. The service uses `~/.bb/bb` when present, otherwise `bb` on `PATH`;
`BB_BIN` overrides this location.

Configuration uses environment variables; see `.env.example`. `PRIVY_JWKS_URL` accepts
comma-separated JWKS URLs for multiple Privy apps. The signature determines the signing key;
the response's `kid` identifies that key when available. Verification must use the corresponding
environment's trusted keys.

### Sizing

Measurements on a 14-core machine are approximately 8 s per attestation: 3 s solving in
single-threaded WASM and 5 s proving, with about 3 GB peak memory. Allow at least 4 GB for an
instance running one proof at a time. Measure memory and latency before increasing
`MAX_CONCURRENCY`, leaving headroom for Node and the host.

### VPS with PM2

```sh
yarn global add pm2
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

### Railway

Set **Root Directory** to `/http-prover` and **Watch Paths** to `/http-prover/**`.
`railway.json` selects the Dockerfile and `/healthz` check. Mount a persistent volume at
`/app/data` for the outbox and set the variables from `.env.example`. The image supplies
`WORK_DIR`, `DB_PATH`, `CIRCUIT_JSON` and `VK_PATH`; allow at least 4 GB for one concurrent proof.

The image includes the committed artifacts in `circuit/`. `pvium_identity.json.gz` contains the
compiled circuit without source maps, approximately 4.6 MB compressed. Startup extracts it when
the uncompressed file is absent. After a circuit change, run `yarn sync` and commit the updated
`.gz`, `vk` and `version.json` with the version bump.

### Docker

```sh
yarn sync && docker build -t pvium-prover .
docker run --env-file .env -p 8787:8787 --shm-size=1g -v prover-data:/app/data pvium-prover
```

The image defaults `WORK_DIR` to `/dev/shm`, a tmpfs filesystem. Witness files contain token
data; their storage and swap behavior depend on the host configuration.

## Deploying from CI

`.github/workflows/deploy-prover.yml` deploys over SSH on a `prover-v*` tag or a manual run,
using the GitHub `production` environment. Configure required reviewers and deployment rules
in that environment, and add these secrets:

| Secret | Value |
| --- | --- |
| `VPS_HOST`, `VPS_USER` | host and deployment user with Node 22.13+, Yarn and PM2; deployment installs or updates `bb` in `~/.bb` |
| `VPS_PASSWORD` | deployment user's password, supplied through `sshpass` |
| `VPS_APP_DIR` | service directory; create its `.env` from `.env.example` on the host; CI excludes it from file synchronization |

The workflow compiles the circuit using a source-based cache, checks the vk hash against
`circuit/version.json`, builds the service, syncs runtime files, reloads PM2 and checks `/healthz`.
To use SSH keys, generate a key with `ssh-keygen -t ed25519`, add the public key to the host's
`~/.ssh/authorized_keys`, store the private key as an environment secret, and replace
`sshpass -e ssh` with `ssh -i` using that key. Keep deployment secrets in the protected environment,
review `.github/` changes (see `CODEOWNERS`), and pin third-party actions to commit SHAs.

## Logging

One line per request on stdout, plus one per callback delivery attempt:

```
2026-09-14T10:00:00.000Z POST /attestations 202 14ms ip=203.0.113.7 mode=async type=email wallet=0x… job=3f2c…
2026-09-14T10:00:09.100Z job 3f2c… ok type=email wallet=0x… callback=api.example.com delivery=delivered
```

Request logs omit the token and identity-value fields. PM2 and Railway collect stdout;
on a VPS, use `pm2-logrotate` to limit log growth.

## Security notes

- Keep the service and its bearer secret accessible only to your backend. A caller with a valid
  token can request a proof for any wallet linked in that token.
- Authentication uses `timingSafeEqual` for equal-length bearer credentials.
- Proof generation removes its temporary directory in a cleanup block. Abrupt process
  termination can leave files behind.
- Callback records contain identity values, wallets and results; protect the outbox database.

## Development

```sh
yarn test
```

Tests compare the TypeScript witness builder with `circuit/scripts/gen_prover.py` byte for byte,
exercise the HTTP layer, queue and callback delivery, and verify generated attestations with
`@pvium/p2id-verifier` when `bb` and the circuit artifacts are available.
