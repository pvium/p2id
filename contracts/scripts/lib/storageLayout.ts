// Checks candidate storage against a supplied baseline, plus hook ABI, reserved signatures
// and selected source-level hazards. These checks do not establish behavioral safety or
// compatibility with state appended by other implementations.
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';

export interface LayoutVar { label: string; slot: string; offset: number; type: string; contract: string }
export interface Layout { storage: LayoutVar[]; types: Record<string, { label: string; numberOfBytes: string; encoding: string; key?: string; value?: string; base?: string; members?: LayoutVar[] }> }

export interface ContractInfo {
  layout: Layout;
  abi: any[];
  /** Fully qualified base contracts (the contract itself first), for source scans. */
  linearized: string[];
  /** Source-level uses of delegatecall / selfdestruct in the contract or its bases. */
  unsafeCalls: string[];
  immutables: string[];
}

/** Selectors PviumP2IDVaultProxy answers itself; an implementation function with one is unreachable. */
export const PROXY_RESERVED = ['implementation()', 'lastUpgrade()', 'upgradeTo(bytes32,address,bytes)'];
export const HOOK = 'acceptOwnerProof(address,address,uint64)';

/** Canonical description of a storage type: its label with nested types expanded, so identical shapes compare equal. */
export function canonicalType(layout: Layout, id: string): string {
  const t = layout.types[id];
  if (!t) return id;
  if (t.encoding === 'mapping') return `mapping(${canonicalType(layout, t.key!)} => ${canonicalType(layout, t.value!)})`;
  if (t.encoding === 'dynamic_array') return `${canonicalType(layout, t.base!)}[]`;
  if (t.members) return `struct{${t.members.map((m) => `${m.label}@${m.slot}+${m.offset}:${canonicalType(layout, m.type)}`).join(',')}}`;
  return `${t.label}/${t.numberOfBytes}`;
}

export interface Finding { level: 'error' | 'warning'; message: string }

/** Compare a candidate implementation's layout against a supplied baseline layout. */
export function compareLayouts(base: Layout, candidate: Layout): Finding[] {
  const out: Finding[] = [];
  const byPosition = (l: Layout) => new Map(l.storage.map((v) => [`${v.slot}:${v.offset}`, v]));
  const cand = byPosition(candidate);
  for (const v of base.storage) {
    const c = cand.get(`${v.slot}:${v.offset}`);
    const want = canonicalType(base, v.type);
    if (!c) {
      out.push({ level: 'error', message: `base variable ${v.label} (slot ${v.slot}, offset ${v.offset}, ${want}) is missing from the candidate` });
      continue;
    }
    const got = canonicalType(candidate, c.type);
    if (got !== want) out.push({ level: 'error', message: `slot ${v.slot} offset ${v.offset}: base has ${v.label}: ${want}, candidate has ${c.label}: ${got}` });
    else if (c.label !== v.label) out.push({ level: 'warning', message: `slot ${v.slot} offset ${v.offset}: ${v.label} renamed to ${c.label} (same type)` });
  }
  // additions must come after everything the base uses
  const baseEnd = base.storage.reduce((m, v) => Math.max(m, Number(v.slot) + Math.ceil(Number(base.types[v.type]?.numberOfBytes ?? 32) / 32)), 0);
  const basePositions = new Set(base.storage.map((v) => `${v.slot}:${v.offset}`));
  for (const c of candidate.storage) {
    if (basePositions.has(`${c.slot}:${c.offset}`)) continue;
    if (Number(c.slot) < baseEnd) out.push({ level: 'error', message: `candidate variable ${c.label} at slot ${c.slot} lies inside the base vault's storage (slots 0..${baseEnd - 1}); new variables must be appended` });
  }
  return out;
}

/** Off-chain checks for one candidate against a baseline; the registry does not run these. */
export function validateImplementation(base: Layout, candidate: ContractInfo): Finding[] {
  const out = compareLayouts(base, candidate.layout);
  const sigs = candidate.abi.filter((f) => f.type === 'function').map((f) => `${f.name}(${f.inputs.map((i: any) => i.type).join(',')})`);
  if (!sigs.includes(HOOK)) out.push({ level: 'error', message: `missing ${HOOK}: the proxy cannot upgrade to it` });
  else {
    const hook = candidate.abi.find((f) => f.type === 'function' && `${f.name}(${f.inputs.map((i: any) => i.type).join(',')})` === HOOK);
    if (!(hook.outputs?.length === 1 && hook.outputs[0].type === 'bytes4')) out.push({ level: 'error', message: `${HOOK} must return bytes4 (its selector) as acknowledgement` });
  }
  for (const r of PROXY_RESERVED) if (sigs.includes(r)) out.push({ level: 'error', message: `${r} is answered by the proxy; the implementation's version would be unreachable` });
  for (const u of candidate.unsafeCalls) out.push({ level: 'error', message: `${u}: runs against the proxy, never allowed in an implementation` });
  for (const i of candidate.immutables) out.push({ level: 'warning', message: `immutable ${i} is fixed at implementation deployment, not per vault (fine for the factory binding; review anything else)` });
  return out;
}

// ---- reading Hardhat build info ----------------------------------------------------------------

function buildInfos(root: string, name: string): any[] {
  const dir = join(root, 'artifacts');
  const matches: string[] = [];
  const [source, contract] = name.includes(':') ? name.split(':') : [undefined, name];
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory() && entry.name !== 'build-info') visit(full);
      else if (entry.name === contract + '.json') {
        const artifact = JSON.parse(readFileSync(full, 'utf8'));
        if (artifact.contractName === contract && (!source || artifact.sourceName === source)) matches.push(full);
      }
    }
  }
  if (!existsSync(dir)) return [];
  visit(dir);
  if (matches.length > 1) throw new Error('Ambiguous contract name; use source:Contract');
  return matches.map((path) => {
    const debug = JSON.parse(readFileSync(path.replace(/\.json$/, '.dbg.json'), 'utf8'));
    return JSON.parse(readFileSync(resolve(dirname(path), debug.buildInfo), 'utf8'));
  });
}

/** Locate a contract by name (or `path:Name`) using its current artifact’s build-info reference. */
export function readContract(root: string, name: string): ContractInfo {
  const [wantPath, wantName] = name.includes(':') ? name.split(':') : [undefined, name];
  for (const b of buildInfos(root, name)) {
    for (const [path, contracts] of Object.entries<any>(b.output.contracts)) {
      if (wantPath && path !== wantPath) continue;
      const c = contracts[wantName];
      if (!c) continue;
      if (!c.storageLayout) throw new Error(`${path}:${wantName} has no storageLayout in build info; enable outputSelection storageLayout and recompile`);
      const nodes = new Map<number, any>();
      const units: any[] = Object.values(b.output.sources).map((s: any) => s.ast);
      for (const unit of units) for (const n of unit.nodes ?? []) if (n.nodeType === 'ContractDefinition') nodes.set(n.id, n);
      const self = [...nodes.values()].find((n) => n.name === wantName && units.some((u) => u.absolutePath === path && u.nodes.includes(n)));
      const linearized: string[] = [];
      const unsafeCalls: string[] = [];
      const immutables: string[] = [];
      for (const id of self?.linearizedBaseContracts ?? []) {
        const n = nodes.get(id);
        if (!n) continue;
        linearized.push(n.name);
        walk(n, (x) => {
          if (x.nodeType === 'MemberAccess' && x.memberName === 'delegatecall') unsafeCalls.push(`${n.name}: delegatecall`);
          if (x.nodeType === 'Identifier' && x.name === 'selfdestruct') unsafeCalls.push(`${n.name}: selfdestruct`);
          if (x.nodeType === 'YulFunctionCall' && ['delegatecall', 'selfdestruct'].includes(x.functionName?.name)) unsafeCalls.push(`${n.name}: assembly ${x.functionName.name}`);
          if (x.nodeType === 'VariableDeclaration' && x.mutability === 'immutable' && x.stateVariable) immutables.push(`${n.name}.${x.name}`);
        });
      }
      return { layout: c.storageLayout, abi: c.abi, linearized, unsafeCalls, immutables };
    }
  }
  throw new Error(`contract ${name} not found in artifacts/build-info; compile first`);
}

function walk(node: any, fn: (n: any) => void) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, fn));
  if (node.nodeType) fn(node);
  for (const [k, v] of Object.entries(node)) if (k !== 'typeDescriptions' && typeof v === 'object') walk(v, fn);
}
