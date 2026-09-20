import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttestationService } from '../src/attestation.js';
import { configFromEnv } from '../src/config.js';
import { InputError } from '../src/errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', 'circuit', 'test', 'fixtures');
const jwt = readFileSync(join(fixtures, 'sample_token.jwt'), 'utf8').trim();
const SERVED_VERSION: number = JSON.parse(readFileSync(join(here, '..', 'circuit', 'version.json'), 'utf8')).circuitVersion;
const pemFile = join(fixtures, 'privy_es256_public.pem');
const WALLET = '0xA01b6E60D51eDB3fEB9f86a62b846f4F90070f98';

const cfg = configFromEnv({ ...process.env, PRIVY_JWKS_URL: undefined, PRIVY_PUBLIC_KEY_PEM_FILE: pemFile,
  CIRCUIT_JSON: join(here, '..', 'circuit', 'pvium_identity.json'), VK_PATH: join(here, '..', 'circuit', 'vk'),
  CIRCUIT_VERSION_JSON: join(here, '..', 'circuit', 'version.json'), ALLOW_HTTP_CALLBACKS: 'true', DB_PATH: ':memory:' });
const canProve = existsSync(cfg.circuitJson) && existsSync(cfg.vkPath) && (cfg.bbBin.includes('/') ? existsSync(cfg.bbBin) : true);

test('bad requests fail fast without proving', async () => {
  const service = new AttestationService(cfg);
  try {
    await assert.rejects(() => service.generate({ identityType: 'email', identityValue: 'x', jwt: 'not.a.jwt.at.all', wallet: WALLET }), InputError);
    await assert.rejects(() => service.generate({ identityType: 'nope' as never, identityValue: 'x', jwt, wallet: WALLET }), InputError);
    await assert.rejects(() => service.generate({ identityType: 'email', identityValue: 'other@privy.io', jwt, wallet: WALLET }), InputError);
  } finally {
    await service.close();
  }
});

test('async job delivers a real attestation to the callback', { skip: !canProve && 'bb / circuit artifacts not available' }, async () => {
  const { createServer } = await import('node:http');
  const { runWebhookJob } = await import('../src/webhook.js');
  const { Outbox } = await import('../src/outbox.js');
  const outbox = new Outbox(':memory:');
  let resolveBody: (b: string) => void;
  const got = new Promise<string>((r) => (resolveBody = r));
  const s = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.end('ok'); resolveBody(b); }); });
  await new Promise<void>((ok) => s.listen(0, ok));
  const service = new AttestationService(cfg);
  try {
    const url = new URL(`http://127.0.0.1:${(s.address() as { port: number }).port}/hook?secret=abc`);
    await runWebhookJob(service, outbox, { identityType: 'email', identityValue: 'test-9988@privy.io', jwt, wallet: WALLET }, url, 'job-1');
    assert.equal(outbox.get('job-1')!.status, 'delivered');
    const d = JSON.parse(await got) as { jobId: string; status: string; attestation: { circuitVersion: number; wallet: string } };
    assert.equal(d.jobId, 'job-1');
    assert.equal(d.status, 'ok');
    assert.equal(d.attestation.wallet, WALLET);
    assert.equal(d.attestation.circuitVersion, SERVED_VERSION);
  } finally {
    s.close();
    outbox.close();
    await service.close();
  }
});

test('a repeated callback request while proving gets the same job, not a second proving run', { skip: !canProve && 'bb / circuit artifacts not available' }, async () => {
  const { createServer } = await import('node:http');
  const { createApp } = await import('../src/app.js');
  const calls: string[] = [];
  let resolveFirst: () => void;
  const firstCall = new Promise<void>((r) => (resolveFirst = r));
  const hook = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { calls.push(b); res.end('ok'); resolveFirst(); }); });
  await new Promise<void>((ok) => hook.listen(0, ok));
  const app = createApp({ ...cfg, maxQueue: 0 }, 'tok');
  const server = await new Promise<import('node:http').Server>((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const callbackUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook?secret=abc`;
  const post = (body: object) => fetch(`${base}/attestations`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok' }, body: JSON.stringify(body) });
  const request = { identityType: 'email', identityValue: 'test-9988@privy.io', jwt, wallet: WALLET, callbackUrl };
  try {
    const first = await post(request);
    assert.equal(first.status, 202);
    const a = (await first.json()) as { jobId: string; status: string };
    assert.equal(a.status, 'queued');

    // Same proof, same receiver, while the first is proving (case differences do not matter).
    const again = await post({ ...request, identityValue: 'TEST-9988@privy.io', wallet: WALLET.toLowerCase() });
    assert.equal(again.status, 202); // not 503, although the prover is at capacity
    const b = (await again.json()) as { jobId: string; status: string; deduplicated: boolean };
    assert.equal(b.jobId, a.jobId);
    assert.equal(b.status, 'proving');
    assert.equal(b.deduplicated, true);

    // A different proof is a different job, and the prover really is busy for it.
    assert.equal((await post({ ...request, identityType: 'github_oauth', identityValue: 'dephizee' })).status, 503);

    // The job can be looked up before it has a result.
    const lookup = (await (await fetch(`${base}/jobs/${a.jobId}`, { headers: { authorization: 'Bearer tok' } })).json()) as { status: string };
    assert.equal(lookup.status, 'proving');

    await firstCall;
    await new Promise((r) => setTimeout(r, 300)); // a second delivery would have arrived by now
    assert.equal(calls.length, 1);
    assert.equal((JSON.parse(calls[0]) as { jobId: string; status: string }).jobId, a.jobId);
    assert.equal((JSON.parse(calls[0]) as { status: string }).status, 'ok');
    const done = (await (await fetch(`${base}/jobs/${a.jobId}`, { headers: { authorization: 'Bearer tok' } })).json()) as { status: string };
    assert.equal(done.status, 'delivered');
  } finally {
    server.close();
    hook.close();
    await app.locals.close();
  }
});

test('generates an attestation the SDK verifies', { skip: !canProve && 'bb / circuit artifacts not available' }, async (t) => {
  const service = new AttestationService(cfg);
  const started = Date.now();
  const a = await service.generate({ identityType: 'email', identityValue: 'test-9988@privy.io', jwt, wallet: WALLET });
  t.diagnostic(`attestation generated in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  assert.equal(a.issuedAt, 1789240094);
  assert.equal(a.wallet, WALLET);
  assert.equal(a.circuitVersion, SERVED_VERSION);
  assert.match(a.vkHash, /^0x[0-9a-f]{64}$/);
  assert.equal(Buffer.from(a.publicInputs, 'base64').length, 11 * 32);

  const { verifyIdentity, shutdown } = await import('@pvium/p2id-verifier');
  try {
    const ok = await verifyIdentity({
      attestation: { proof: a.proof, publicInputs: a.publicInputs, wallet: a.wallet! },
      signer: readFileSync(pemFile, 'utf8'), identityType: 'email', identityValue: 'TEST-9988@privy.io',
    });
    assert.deepEqual(ok, { valid: true, wallet: WALLET, issuedAt: 1789240094 });
    const wrong = await verifyIdentity({
      attestation: { proof: a.proof, publicInputs: a.publicInputs, wallet: '0x899BA183F2c55BF9C627D9Af2984fbdED2E64311' },
      signer: readFileSync(pemFile, 'utf8'), identityType: 'email', identityValue: 'test-9988@privy.io',
    });
    assert.equal(wrong.valid, false);
  } finally {
    await shutdown();
    await service.close();
  }
});
