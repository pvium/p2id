// Client for `sunspotd`, the resident Sunspot prover (http-prover/sunspotd/main.go). The daemon
// loads the ACIR, the constraint system and the multi-gigabyte proving key once, then proves on
// request over stdin/stdout, one JSON object per line. Starting it costs the key's load time, a
// prove costs no I/O beyond the witness, and the key is resident in exactly one process.
//
// The daemon serves requests in order, one at a time; this client hands them over as they come
// (the Prover's concurrency gate is in front of it) and matches responses by id. If the daemon
// exits, every request in flight fails and the next request starts it again.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { sunspotCcsPath, type ProverConfig } from './config.js';

export interface SunspotdReady {
  constraints: number;
  publicInputs: number;
  loadMs: number;
  /** How the constraint system came to be: "read", "compiled" or "compiled, cached". */
  ccs?: string;
}

interface Pending {
  resolve: (r: { proof: Buffer; publicWitness: Buffer; ms: number }) => void;
  reject: (e: Error) => void;
}

export class SunspotDaemon {
  private child?: ChildProcess;
  private starting?: Promise<SunspotdReady>;
  private pending = new Map<string, Pending>();
  private nextId = 1;
  info?: SunspotdReady;

  constructor(private readonly cfg: ProverConfig) {}

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed;
  }

  /** Start the daemon (idempotent) and resolve when it has loaded the key. */
  start(): Promise<SunspotdReady> {
    if (this.running && this.info) return Promise.resolve(this.info);
    if (this.starting) return this.starting;
    this.starting = this.spawnDaemon().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async prove(witness: Uint8Array): Promise<{ proof: Buffer; publicWitness: Buffer; ms: number }> {
    await this.start();
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const line = JSON.stringify({ id, witness: Buffer.from(witness).toString('base64') }) + '\n';
      this.child!.stdin!.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new Error(`sunspotd: ${err.message}`));
        }
      });
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.info = undefined;
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  private spawnDaemon(): Promise<SunspotdReady> {
    const { sunspotdBin, sunspotAcirPath, sunspotPkPath, workDir } = this.cfg;
    if (!sunspotPkPath) return Promise.reject(new Error('Solana proving is not configured (SUNSPOT_PK_PATH or SUNSPOT_PK_URL)'));
    let ccs: string;
    try { ccs = sunspotCcsPath(this.cfg); } catch (e) { return Promise.reject(e as Error); }
    const args = ['--acir', sunspotAcirPath, '--pk', sunspotPkPath, '--ccs', ccs, '--work', workDir];
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(sunspotdBin, args, { stdio: ['pipe', 'pipe', 'inherit'] });
      } catch (e) {
        reject(new Error(`sunspotd not runnable at "${sunspotdBin}": ${(e as Error).message}`));
        return;
      }
      this.child = child;
      let ready = false;
      const fail = (message: string) => {
        const err = new Error(message);
        if (!ready) reject(err);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        if (this.child === child) { this.child = undefined; this.info = undefined; }
      };
      child.on('error', (e) => fail(`sunspotd not runnable at "${sunspotdBin}": ${e.message}`));
      child.on('exit', (code, signal) => fail(`sunspotd exited (${signal ?? `code ${code}`})`));
      const lines = createInterface({ input: child.stdout! });
      lines.on('line', (text) => {
        let msg: any;
        try { msg = JSON.parse(text); } catch { return; }
        if (!ready) {
          if (msg.ready === true) {
            ready = true;
            this.info = { constraints: msg.constraints, publicInputs: msg.publicInputs, loadMs: msg.loadMs, ccs: msg.ccs };
            resolve(this.info);
          } else if (msg.ready === false) {
            fail(`sunspotd failed to start: ${msg.error}`);
            child.kill();
          }
          return;
        }
        const p = this.pending.get(String(msg.id));
        if (!p) return;
        this.pending.delete(String(msg.id));
        if (msg.error) p.reject(new Error(`sunspotd: ${msg.error}`));
        else p.resolve({ proof: Buffer.from(msg.proof, 'base64'), publicWitness: Buffer.from(msg.publicWitness, 'base64'), ms: msg.ms });
      });
    });
  }
}
