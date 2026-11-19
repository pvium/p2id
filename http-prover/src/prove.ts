import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import type { ProverConfig } from './config.js';
import { InputError } from './errors.js';
import type { CircuitInputs } from './witness.js';

const execFileAsync = promisify(execFile);

export type ProofNetwork = 'ethereum' | 'solana';

export interface ProofBundle {
  proof: Buffer;
  publicInputs: Buffer;
  /** Sunspot's complete serialized gnark public witness, required by Solana verifiers. */
  publicWitness?: Buffer;
}

/** Thrown when the wait queue is full; the HTTP layer maps it to 503 + Retry-After. */
export class QueueFullError extends Error {
  constructor(public readonly queued: number) {
    super(`prover queue is full (${queued} waiting)`);
    this.name = 'QueueFullError';
  }
}

/**
 * Solves the circuit in a worker thread (noir_js WASM) and proves with the native bb binary.
 * Jobs are gated to `maxConcurrency` at a time (each prove peaks ~3 GB) with a bounded wait queue.
 */
export class Prover {
  private worker: Worker;
  private sunspotWorker?: Worker;
  private nextId = 1;
  private pending = new Map<number, { worker: Worker; resolve: (w: Uint8Array) => void; reject: (e: Error) => void }>();
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly cfg: ProverConfig) {
    this.worker = this.createWorker(cfg.circuitJson);
  }

  get stats() {
    return { inFlight: this.running, queued: this.queue.length, maxConcurrency: this.cfg.maxConcurrency, maxQueue: this.cfg.maxQueue };
  }

  async prove(inputs: CircuitInputs, network: ProofNetwork = 'ethereum'): Promise<ProofBundle> {
    await this.acquire();
    try {
      const witness = await this.solve(inputs, network);
      return network === 'solana' ? await this.runSunspot(witness) : await this.runBb(witness);
    } finally {
      this.release();
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.worker.terminate(), this.sunspotWorker?.terminate()]);
  }

  private solve(inputs: CircuitInputs, network: ProofNetwork): Promise<Uint8Array> {
    const id = this.nextId++;
    const worker = network === 'solana' && this.cfg.sunspotAcirPath
      ? (this.sunspotWorker ??= this.createWorker(resolve(this.cfg.sunspotAcirPath)))
      : this.worker;
    // Keep the process alive while a solve is in flight; the worker is unref'd when idle so an
    // otherwise-finished process (tests, CLI use) can exit without an explicit close().
    worker.ref();
    return new Promise<Uint8Array>((resolve, reject) => {
      this.pending.set(id, { worker, resolve, reject });
      worker.postMessage({ id, inputs });
    }).finally(() => {
      if (![...this.pending.values()].some((p) => p.worker === worker)) worker.unref();
    });
  }

  private createWorker(circuitJson: string): Worker {
    const workerFile = fileURLToPath(new URL(
      import.meta.url.endsWith('.ts') ? './solver.worker.ts' : './solver.worker.js',
      import.meta.url,
    ));
    const worker = new Worker(workerFile, {
      workerData: { circuitJson },
    });
    worker.on('message', (m: { id: number; witness?: Uint8Array; error?: string }) => {
      const p = this.pending.get(m.id);
      if (!p || p.worker !== worker) return;
      this.pending.delete(m.id);
      if (m.witness) p.resolve(m.witness);
      else p.reject(new InputError(`circuit rejected the inputs: ${m.error}`));
    });
    worker.on('error', (e) => {
      for (const [id, p] of this.pending) {
        if (p.worker === worker) {
          p.reject(e);
          this.pending.delete(id);
        }
      }
    });
    worker.unref();
    return worker;
  }

  private async runSunspot(witness: Uint8Array): Promise<ProofBundle> {
    return runSunspot(this.cfg, witness);
  }

  /** bb proves and, with --verify, checks its own output against the vk before we return it. */
  private async runBb(witness: Uint8Array): Promise<ProofBundle> {
    const dir = await mkdtemp(join(this.cfg.workDir, 'pvium-prove-'));
    try {
      const witnessPath = join(dir, 'witness.gz');
      const outDir = join(dir, 'out');
      await writeFile(witnessPath, witness);
      await execFileAsync(
        this.cfg.bbBin,
        ['prove', '-b', this.cfg.circuitJson, '-w', witnessPath, '-t', 'evm', '-k', this.cfg.vkPath, '--verify', '-o', outDir],
        { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
      );
      const [proof, publicInputs] = await Promise.all([readFile(join(outDir, 'proof')), readFile(join(outDir, 'public_inputs'))]);
      return { proof, publicInputs };
    } finally {
      await rm(dir, { recursive: true, force: true }); // the witness contains the token
    }

  }

  private acquire(): Promise<void> {
    if (this.running < this.cfg.maxConcurrency) {
      this.running++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.cfg.maxQueue) return Promise.reject(new QueueFullError(this.queue.length));
    return new Promise((resolve) => this.queue.push(() => { this.running++; resolve(); }));
  }

  private release(): void {
    this.running--;
    this.queue.shift()?.();
  }
}

export async function runSunspot(cfg: ProverConfig, witness: Uint8Array): Promise<ProofBundle> {
  const ccsPath = cfg.sunspotCcsPath;
  const pkPath = cfg.sunspotPkPath;
  if (!ccsPath || !pkPath) {
    throw new Error('Solana proving is not configured; set SUNSPOT_CCS_PATH and SUNSPOT_PK_PATH');
  }

  const acirPath = resolve(cfg.sunspotAcirPath ?? cfg.circuitJson);
  const absoluteCcsPath = resolve(ccsPath);
  const absolutePkPath = resolve(pkPath);
  await Promise.all([access(acirPath), access(absoluteCcsPath), access(absolutePkPath)]);

  const dir = await mkdtemp(join(cfg.workDir, 'pvium-prove-'));
  try {
    const witnessPath = join(dir, 'witness.gz');
    const ccsLink = join(dir, 'circuit.ccs');
    const outputBase = join(dir, 'circuit');
    await Promise.all([
      writeFile(witnessPath, witness),
      symlink(absoluteCcsPath, ccsLink),
    ]);
    await execFileAsync(
      cfg.sunspotBin,
      ['prove', acirPath, witnessPath, ccsLink, absolutePkPath],
      { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
    );
    const [proof, publicWitness] = await Promise.all([
      readFile(`${outputBase}.proof`),
      readFile(`${outputBase}.pw`),
    ]);
    return {
      proof,
      publicWitness,
      publicInputs: publicWitness,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
