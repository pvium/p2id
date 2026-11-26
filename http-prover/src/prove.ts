import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import type { ProverConfig } from './config.js';
import { InputError } from './errors.js';
import { SunspotDaemon, type SunspotdReady } from './sunspotd.js';
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
 * Solves the circuit in a worker thread (noir_js WASM) and proves with the native bb binary
 * (Ethereum) or the resident sunspotd prover (Solana). Jobs are gated to `maxConcurrency` at a time
 * (an Ethereum prove peaks ~3 GB; a Solana prove runs inside sunspotd, which holds the proving key
 * resident and proves one at a time) with a bounded wait queue.
 */
export class Prover {
  private worker: Worker;
  private sunspotWorker?: Worker;
  readonly sunspotd: SunspotDaemon;
  private nextId = 1;
  private pending = new Map<number, { worker: Worker; resolve: (w: Uint8Array) => void; reject: (e: Error) => void }>();
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly cfg: ProverConfig) {
    this.worker = this.createWorker(cfg.circuitJson);
    this.sunspotd = new SunspotDaemon(cfg);
  }

  /** Start the Solana prover now (loads the proving key) instead of on the first request. */
  startSolana(): Promise<SunspotdReady> {
    return this.sunspotd.start();
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
    await Promise.all([this.worker.terminate(), this.sunspotWorker?.terminate(), this.sunspotd.close()]);
  }

  private solve(inputs: CircuitInputs, network: ProofNetwork): Promise<Uint8Array> {
    const id = this.nextId++;
    // Solana witnesses come from the ACIR Sunspot reads (compiled with its Noir release), never
    // from the Ethereum artifact: the two circuits' witness layouts are not interchangeable.
    const worker = network === 'solana'
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

  /** The witness never touches the disk here; sunspotd keeps it on its work dir for the prove. */
  private async runSunspot(witness: Uint8Array): Promise<ProofBundle> {
    if (!this.cfg.sunspotPkPath) throw new Error('Solana proving is not configured; set SUNSPOT_PK_PATH or SUNSPOT_PK_URL');
    const { proof, publicWitness } = await this.sunspotd.prove(witness);
    return { proof, publicWitness, publicInputs: publicWitness };
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
