import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Keypair } from '@solana/web3.js';
import { programIdEdits } from '../scripts/lib/programIds';

describe('derived program ID source sync', () => {
  let root: string;
  const oldId = Keypair.generate().publicKey;
  const router = Keypair.generate().publicKey;
  const backend = Keypair.generate().publicKey;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'p2id-program-id-test-'));
    mkdirSync(join(root, 'programs', 'router', 'src'), { recursive: true });
    mkdirSync(join(root, '.cargo'));
    writeFileSync(join(root, 'programs', 'router', 'src', 'lib.rs'), `use anchor_lang::prelude::*;\ndeclare_id!("${oldId}");\n// business logic\n`);
    writeFileSync(join(root, 'Anchor.toml'), `[programs.localnet]\nrouter = "${oldId}"\ntest_hook = "${oldId}"\n\n[programs.mainnet]\nrouter = "${oldId}"\n\n[provider]\ncluster = "localnet"\n`);
    writeFileSync(join(root, '.cargo', 'config.toml'), `[env]\nP2ID_ZK_VERIFIER = "${oldId}"\n`);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('updates declarations, sandbox cluster tables and backend while preserving other configuration', () => {
    const edits = programIdEdits(root, { router }, backend, 'sandbox');
    const source = edits.find((edit) => edit.path.endsWith('lib.rs'))!.content;
    assert(source.includes(`declare_id!("${router}");`));
    assert(source.endsWith('// business logic\n'));
    const anchor = edits.find((edit) => edit.path.endsWith('Anchor.toml'))!.content;
    assert(anchor.includes(`[programs.localnet]\nrouter = "${router}"`));
    assert(anchor.includes(`[programs.devnet]\nrouter = "${router}"`));
    assert(anchor.includes(`[programs.mainnet]\nrouter = "${oldId}"`));
    assert(anchor.includes(`test_hook = "${oldId}"`));
    assert(anchor.includes('[provider]\ncluster = "localnet"'));
    assert(edits.find((edit) => edit.path.endsWith('config.toml'))!.content.includes(`P2ID_ZK_VERIFIER = "${backend}"`));
    // Planning the sync itself never mutates the source.
    assert(readFileSync(join(root, 'programs', 'router', 'src', 'lib.rs'), 'utf8').includes(oldId.toBase58()));
    for (const edit of edits) writeFileSync(edit.path, edit.content);
    assert.deepEqual(programIdEdits(root, { router }, backend, 'sandbox'), edits);
  });

  it('updates the production cluster without rewriting sandbox cluster configuration', () => {
    const anchor = programIdEdits(root, { router }, backend, 'production').find((edit) => edit.path.endsWith('Anchor.toml'))!.content;
    assert(anchor.includes(`[programs.mainnet]\nrouter = "${router}"`));
    assert(anchor.includes(`[programs.localnet]\nrouter = "${oldId}"`));
  });

  it('rejects ambiguous source declarations and missing backend settings before applying edits', () => {
    const path = join(root, 'programs', 'router', 'src', 'lib.rs');
    writeFileSync(path, '// no declaration\n');
    assert.throws(() => programIdEdits(root, { router }, backend, 'sandbox'), /exactly one declare_id/);
    writeFileSync(path, `declare_id!("${oldId}");`);
    writeFileSync(join(root, '.cargo', 'config.toml'), '[env]\n');
    assert.throws(() => programIdEdits(root, { router }, backend, 'sandbox'), /exactly one P2ID_ZK_VERIFIER/);
    assert.equal(readFileSync(path, 'utf8'), `declare_id!("${oldId}");`);
  });
});
