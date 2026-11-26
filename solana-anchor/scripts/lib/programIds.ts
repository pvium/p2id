import { PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Environment } from '../../deploy.config';

export interface ProgramIdEdit { path: string; content: string }

/** Prepare every edit before writing, so an invalid source/config cannot cause a partial sync. */
export function programIdEdits(
  root: string,
  programs: Record<string, PublicKey>,
  zkVerifier: PublicKey,
  environment: Environment,
): ProgramIdEdit[] {
  const edits: ProgramIdEdit[] = [];
  for (const [crate, id] of Object.entries(programs)) {
    if (!/^[a-z][a-z0-9_]*$/.test(crate)) throw new Error('Invalid program crate name');
    const path = join(root, 'programs', crate, 'src', 'lib.rs');
    const source = readFileSync(path, 'utf8');
    const declarations = [...source.matchAll(/\bdeclare_id!\(\s*"[1-9A-HJ-NP-Za-km-z]+"\s*\)/g)];
    if (declarations.length !== 1) throw new Error(`${crate}: expected exactly one declare_id! declaration`);
    edits.push({ path, content: source.replace(declarations[0][0], `declare_id!("${id.toBase58()}")`) });
  }

  const anchorPath = join(root, 'Anchor.toml');
  let anchor = readFileSync(anchorPath, 'utf8');
  const clusters = environment === 'sandbox' ? ['localnet', 'devnet'] : ['mainnet'];
  for (const cluster of clusters) {
    const section = new RegExp(`(\\[programs\\.${cluster}\\][^\\S\\n]*\\n)([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'm');
    const existing = anchor.match(section);
    let body = existing?.[2] ?? '';
    for (const [crate, id] of Object.entries(programs)) {
      const entry = new RegExp(`^${crate}\\s*=.*$`, 'm');
      const line = `${crate} = "${id.toBase58()}"`;
      body = entry.test(body) ? body.replace(entry, line) : body.trimEnd() + '\n' + line + '\n';
    }
    anchor = existing
      ? anchor.replace(section, () => existing[1] + body)
      : anchor.trimEnd() + `\n\n[programs.${cluster}]\n${body.trim()}\n`;
  }
  edits.push({ path: anchorPath, content: anchor });

  const cargoPath = join(root, '.cargo', 'config.toml');
  const cargo = readFileSync(cargoPath, 'utf8');
  const backend = /^P2ID_ZK_VERIFIER\s*=.*$/gm;
  if ([...cargo.matchAll(backend)].length !== 1)
    throw new Error('.cargo/config.toml must have exactly one P2ID_ZK_VERIFIER entry');
  edits.push({ path: cargoPath, content: cargo.replace(backend, `P2ID_ZK_VERIFIER = "${zkVerifier.toBase58()}"`) });
  return edits;
}
