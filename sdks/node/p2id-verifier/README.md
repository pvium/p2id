# @pvium/p2id-verifier

Verify that a Privy-signed token links an identity and a wallet to the same account. The package
checks the attestation's zero-knowledge proof locally using a bundled circuit verification key
and the configured trusted signing keys.

## Install

```sh
yarn add @pvium/p2id-verifier
```

Requires Node.js 20+.

## Quick start

```ts
import { verifyIdentity, AttestationSigner, IdentityType, shutdown } from '@pvium/p2id-verifier';

const result = await verifyIdentity({
  attestation,                          // proof, public inputs and wallet
  signer: AttestationSigner.Production, // trusted Privy signing keys
  identityType: IdentityType.Email,     // identity type from the original request
  identityValue: 'you@example.com',      // identity value from the original request
});

if (result.valid) {
  console.log(result.wallet);   // wallet linked to the email in the signed token
  console.log(result.issuedAt); // token issue time, in Unix seconds
} else {
  console.log(result.reason);
}

await shutdown(); // release the backend after verification is complete
```

Pass the identity type and value from the original request. Verification checks these values
and the attestation's wallet against the proof.

## Obtain an attestation

JSON representation:

```json
{
  "proof": "<base64>",
  "publicInputs": "<base64>",
  "wallet": "0xA01b6E60D51eDB3fEB9f86a62b846f4F90070f98",
  "circuitVersion": 1
}
```

**Pvium API or SDK:** recipient resolution can return an attestation summary. Fetch the full
attestation and pass it to `verifyIdentity` (see
[With the Pvium SDK](#with-the-pvium-sdk)).

**Self-hosted prover:** request an attestation from the
[prover service](https://github.com/pvium/zkid/tree/main/http-prover):

```sh
curl -s https://your-prover/attestations \
  -H "authorization: Bearer $AUTH_TOKEN" -H 'content-type: application/json' \
  -d '{ "identityType": "email", "identityValue": "you@example.com",
        "wallet": "0xA01b6E60D51eDB3fEB9f86a62b846f4F90070f98", "jwt": "<Privy identity token>" }'
```

Pass the response to `verifyIdentity` with `signer` set to your Privy app's JWKS URL.

## Reading the result

| `result` | Meaning |
| --- | --- |
| `{ valid: true, wallet, issuedAt }` | The signed token links the requested identity and wallet. `issuedAt` is the token's issue time. |
| `reason: 'identity value mismatch'` / `'identity type mismatch'` | The public inputs do not match the requested identity. |
| `reason: 'wallet mismatch'` | The wallet does not match the public inputs. |
| `reason: 'attestation carries no wallet'` | The public inputs contain no wallet commitment. |
| `reason: 'not signed by a trusted key'` | The signing key is not accepted by the configured `signer`. |
| `reason: 'invalid proof'` | The proof does not verify. |
| `reason: 'attestation is for circuit version N; …'` or `'… different circuit build …'` | The declared circuit version or verification-key hash differs from this release (see [Versioning](#versioning)). |
| `reason: 'malformed attestation: …'` | The public inputs could not be decoded. |
| `reason: 'unknown identity type "…"'` / `'unrecognised signer: …'` | The identity type or signer argument is unsupported. |

These failures return `{ valid: false, reason }`. Malformed input and backend initialization
errors can also throw; callers should handle rejected promises.

The package does not enforce an attestation age. Apply an application-specific limit to
`issuedAt`; this example uses 30 days:

```ts
const MAX_AGE = 30 * 24 * 3600;
if (!result.valid) throw new Error(result.reason);
const age = Date.now() / 1000 - result.issuedAt;
if (age < 0 || age > MAX_AGE) throw new Error('attestation outside the accepted time window');
```

## In a server

Using Express 5:

```ts
import express from 'express';
import { verifyIdentity, AttestationSigner, IdentityType, shutdown } from '@pvium/p2id-verifier';

const app = express().use(express.json({ limit: '64kb' }));

app.post('/verify-identity', async (req, res) => {
  const { email, attestation } = req.body;
  const check = await verifyIdentity({ attestation, signer: AttestationSigner.Production, identityType: IdentityType.Email, identityValue: email });
  res.status(check.valid ? 200 : 422).json(check);
});

process.on('SIGTERM', () => shutdown());
```

The Barretenberg backend initializes on first proof verification and is reused. Startup time
depends on the runtime and backend. Browser builds use WASM and workers.

## Reading a claim without verifying it

`decodeClaim` reads public inputs without checking the proof. Treat the decoded fields as
unverified until verification succeeds.

```ts
import { decodeClaim } from '@pvium/p2id-verifier';

const claim = decodeClaim(Buffer.from(attestation.publicInputs, 'base64'));
claim.identityType; // numeric identity type ID
claim.identityHash; // commitment to (type, value)
claim.wallet;       // reported EVM wallet, or null
claim.iat;          // reported token issue time
claim.signer;       // { x, y }: reported P-256 signing key
```

## Trusted signers

`signer` selects the trusted token-signing keys.

| `signer` | Use |
| --- | --- |
| `AttestationSigner.Production` (or `'production'`) | Pvium's production Privy keys, pinned in `PVIUM_ENVIRONMENTS.production.keys`. Unknown keys trigger a lookup against the app's JWKS. |
| `AttestationSigner.Sandbox` (or `'sandbox'`) | Pvium's sandbox Privy keys, with the same pinning and lookup behavior. |
| A JWKS URL string, or `{ jwksUrl }` | Accept P-256 keys from the specified JWKS. |
| PEM string or `{ x, y }` | Accept one specified P-256 key. |

`PVIUM_ENVIRONMENTS` exposes app IDs, JWKS URLs and pinned keys. Pinned keys remain trusted
until removed in a package release. JWKS responses are cached for ten minutes.

## With the Pvium SDK

Use `payout.getAttestation` to fetch a proof from a recipient's attestation summary. Verify it
against the identity in the original request:

```ts
import { PviumSdk } from '@pvium/sdk';
import { verifyIdentity, AttestationSigner } from '@pvium/p2id-verifier';

const pvium = new PviumSdk({ apiKey: process.env.PVIUM_API_KEY!, environment: 'production' });
const recipient = { identityType: 'email' as const, identityValue: 'you@example.com' };
const { data } = await pvium.payout.resolveRecipients(batchId, [recipient]);
const summary = data.resolved[0]?.attestation;
if (!summary) throw new Error('attestation unavailable');

const attestation = await pvium.payout.getAttestation(summary);
const result = await verifyIdentity({
  attestation,
  signer: AttestationSigner.Production,
  identityType: recipient.identityType,
  identityValue: recipient.identityValue,
});
if (!result.valid) throw new Error(result.reason);
// Apply the freshness policy, then use result.wallet as the payment destination.
```

An absent attestation does not establish an identity-to-wallet binding. Wallet payees do not
require one; for identity payees, retry resolution when the proof is available.

## Exports

| Export | Purpose |
| --- | --- |
| `verifyIdentity(input)` | Verify an identity-to-wallet attestation |
| `AttestationSigner`, `PVIUM_ENVIRONMENTS` | Signer presets, app IDs, JWKS URLs and pinned keys |
| `decodeClaim(publicInputs)`, `toPublicInputFields`, `PUBLIC_INPUT_COUNT` | Decode and format public inputs without proof verification |
| `shutdown()` | Release the verification backend |
| `CIRCUIT_VERSION`, `VK_SHA256` | Supported circuit version and verification-key hash |
| `IdentityType`, `IdentityTypeName` | Identity types re-exported from `@pvium/p2id-core` |

Proof bytes and public inputs accept `Uint8Array` or base64 strings. Public inputs also accept
an array of hexadecimal fields.

## Versioning

Each release includes a verification key for one circuit version (`CIRCUIT_VERSION`).
`@aztec/bb.js` is pinned to the matching Barretenberg version (`5.0.0-nightly.20260522`).
Preserve `circuitVersion` and `vkHash` when passing attestations so mismatches can be reported
before proof verification. Circuit changes require a new package release; use the release
matching the attestation's circuit version and verification key.
