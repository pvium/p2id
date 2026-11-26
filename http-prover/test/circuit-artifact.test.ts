import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { checkCircuitHash, ensureCircuitJson, loadCircuitVersion } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));

test('the committed .gz inflates to a circuit bb and noir_js can load, matching the full build', () => {
  const gz = join(here, '..', 'circuit', 'pvium_identity.json.gz');
  const dir = mkdtempSync(join(tmpdir(), 'pvium-circuit-'));
  writeFileSync(join(dir, 'pvium_identity.json.gz'), readFileSync(gz));
  const cfg = { circuitJson: join(dir, 'pvium_identity.json') } as Parameters<typeof ensureCircuitJson>[0];
  ensureCircuitJson(cfg);
  assert.ok(existsSync(cfg.circuitJson));
  const slim = JSON.parse(readFileSync(cfg.circuitJson, 'utf8'));
  assert.deepEqual(Object.keys(slim).sort(), ['abi', 'bytecode', 'hash', 'noir_version']);
  const full = JSON.parse(readFileSync(join(here, '..', 'circuit', 'pvium_identity.json'), 'utf8'));
  assert.equal(slim.bytecode, full.bytecode);
  assert.equal(slim.hash, full.hash);
  ensureCircuitJson(cfg); // idempotent
});

test('a missing archive is reported clearly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pvium-circuit-'));
  assert.throws(() => ensureCircuitJson({ circuitJson: join(dir, 'x.json') } as never), /run yarn sync/);
  writeFileSync(join(dir, 'y.json.gz'), gzipSync('{"bytecode":"","abi":{},"hash":"0","noir_version":"t"}'));
  ensureCircuitJson({ circuitJson: join(dir, 'y.json') } as never);
  assert.ok(existsSync(join(dir, 'y.json')));
});

test('startup accepts the committed artifacts and refuses a rebuilt circuit with the right vk', () => {
  const circuitDir = join(here, '..', 'circuit');
  const version = JSON.parse(readFileSync(join(circuitDir, 'version.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'pvium-circuit-'));
  writeFileSync(join(dir, 'pvium_identity.json.gz'), readFileSync(join(circuitDir, 'pvium_identity.json.gz')));
  const cfg = { circuitJson: join(dir, 'pvium_identity.json'), vkPath: join(circuitDir, 'vk'), versionJson: join(circuitDir, 'version.json') } as Parameters<typeof loadCircuitVersion>[0];
  ensureCircuitJson(cfg);
  const v = loadCircuitVersion(cfg);
  assert.equal(v.circuitVersion, version.circuitVersion);
  assert.equal(v.circuitHash, version.circuitHash);
  assert.match(v.sunspotCircuitHash, /^\d+$/);
  // The committed Sunspot ACIR is the one the Sunspot keys were generated from.
  const sunspot = join(dir, 'pvium_identity.sunspot.json');
  writeFileSync(sunspot, gunzipSync(readFileSync(join(circuitDir, 'pvium_identity.sunspot.json.gz'))));
  checkCircuitHash(sunspot, v.sunspotCircuitHash, 'test');
  // Same source recompiled: a different nargo hash with the same vk must not start.
  const rebuilt = readFileSync(cfg.circuitJson, 'utf8').replace(/"hash":"\d+"/, '"hash":"7903614907720444181"');
  assert.notEqual(rebuilt, readFileSync(cfg.circuitJson, 'utf8'));
  writeFileSync(cfg.circuitJson, rebuilt);
  assert.throws(() => loadCircuitVersion(cfg), /hash 7903614907720444181 but version.json pins \d+ .*rebuilt/);
  // The hash is a 64-bit decimal: it must be compared as text, and nargo's pretty-printed form must read too.
  writeFileSync(cfg.circuitJson, '{\n  "hash": "1271198581041919219",\n  "bytecode": ""\n}');
  checkCircuitHash(cfg.circuitJson, '1271198581041919219', 'test');
  assert.throws(() => checkCircuitHash(cfg.circuitJson, '1271198581041919218', 'test'), /pins 1271198581041919218/);
  writeFileSync(cfg.circuitJson, '{"bytecode":""}');
  assert.throws(() => checkCircuitHash(cfg.circuitJson, '1', 'test'), /no circuit hash/);
  // version.json without the pin is refused rather than skipping the check.
  writeFileSync(join(dir, 'version.json'), JSON.stringify({ ...version, circuitHash: undefined }));
  assert.throws(() => loadCircuitVersion({ ...cfg, versionJson: join(dir, 'version.json') }), /has no circuitHash/);
});
