import { createHash } from 'node:crypto';

/**
 * Callback jobs that are queued or proving right now. A job only reaches the outbox once its proof
 * (or error) exists, so this is what lets a repeated request find the job already working on the
 * same proof instead of starting another ~3 GB, multi-second proving run.
 *
 * Two requests are the same job when they ask for the same fact (identity type, identity value,
 * wallet) to be delivered to the same callback URL. The URL is part of the key on purpose: a
 * different receiver would otherwise be handed a job id whose result is never delivered to it.
 * The JWT is not part of the key: a retry may carry a fresher token for the same user, and the
 * proof in flight already establishes the same fact.
 */
export class InFlightJobs {
  private readonly byKey = new Map<string, string>();
  private readonly byId = new Map<string, { key: string; startedAt: number }>();

  /** Key for a request. Values are normalised the way the identity hash is, so case does not split jobs. */
  static key(req: { identityType: string; identityValue: string; wallet?: string }, callbackUrl: URL): string {
    const value = req.identityType === 'phone' || (req.identityType === 'wallet' && !req.identityValue.startsWith('0x')) ? req.identityValue : req.identityValue.toLowerCase();
    const wallet = req.wallet === undefined ? '' : req.wallet.startsWith('0x') ? req.wallet.toLowerCase() : req.wallet;
    // Length-prefixed fields, so no value can be crafted to collide with another field split.
    const h = createHash('sha256');
    for (const part of [req.identityType, value, wallet, callbackUrl.toString()]) h.update(`${Buffer.byteLength(part)}:${part}`);
    return h.digest('hex');
  }

  find(key: string): string | undefined {
    return this.byKey.get(key);
  }

  add(key: string, jobId: string): void {
    this.byKey.set(key, jobId);
    this.byId.set(jobId, { key, startedAt: Date.now() });
  }

  /** Call once the job's outcome is in the outbox (or it failed before getting there). */
  remove(jobId: string): void {
    const job = this.byId.get(jobId);
    if (!job) return;
    this.byId.delete(jobId);
    if (this.byKey.get(job.key) === jobId) this.byKey.delete(job.key);
  }

  get(jobId: string): { startedAt: number } | undefined {
    return this.byId.get(jobId);
  }

  get size(): number {
    return this.byId.size;
  }
}
