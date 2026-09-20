import { timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { AttestationService } from './attestation.js';
import type { ProverConfig } from './config.js';
import { InputError } from './errors.js';
import { QueueFullError } from './prove.js';
import { Dispatcher, parseCallbackUrl, runWebhookJob } from './webhook.js';
import { InFlightJobs } from './inflight.js';
import { Outbox } from './outbox.js';
import { randomUUID } from 'node:crypto';

/**
 * One line per request on stdout (PM2 / Railway collect it):
 *   2026-09-14T10:00:00.000Z POST /attestations 202 14ms ip=1.2.3.4 mode=async type=email wallet=0x… job=…
 * Never logs the token or the identity value: one is a credential, the other personal data.
 */
function requestLog(req: Request, res: Response, next: NextFunction) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const extra = Object.entries((res.locals.log ?? {}) as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ?? req.socket.remoteAddress ?? '-';
    console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(0)}ms ip=${ip}${extra ? ' ' + extra : ''}`);
  });
  next();
}

export function createApp(cfg: ProverConfig, secret: string) {
  if (!secret) throw new Error('AUTH_TOKEN is required');
  const service = new AttestationService(cfg);
  const outbox = new Outbox(cfg.dbPath);
  const inflight = new InFlightJobs();
  const dispatcher = new Dispatcher(outbox, cfg.dispatchIntervalMs);
  dispatcher.start();
  const app = express();
  app.locals.service = service; // for tests and graceful shutdown
  app.locals.outbox = outbox;
  app.locals.close = async () => {
    dispatcher.stop();
    await service.close();
    outbox.close();
  };
  app.disable('x-powered-by');
  app.use(requestLog);
  app.use(express.json({ limit: '64kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, circuitVersion: service.version.circuitVersion, vkHash: service.version.vkSha256, ...service.stats, jobs: outbox.counts() });
  });

  const auth = (req: Request, res: Response, next: NextFunction) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    const want = Buffer.from(`Bearer ${secret}`);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  app.post('/attestations', auth, async (req, res) => {
    // Never log req.body: the jwt is a bearer credential for the user's Privy session.
    const body = req.body ?? {};
    const busy = () => service.stats.queued >= cfg.maxQueue && service.stats.inFlight >= cfg.maxConcurrency;
    const refuseBusy = () => res.set('retry-after', '10').status(503).json({ error: 'prover busy; retry later', ...service.stats });
    if (body.callbackUrl !== undefined) {
      const callback = parseCallbackUrl(body.callbackUrl, cfg.allowHttpCallbacks);
      // Validate cheaply before accepting, so a malformed request still gets a 400 not a webhook error.
      service.validateRequest(body);
      // The same proof for the same receiver is already queued or proving: hand back that job
      // (even when busy: it costs nothing) instead of starting another proving run.
      const key = InFlightJobs.key(body, callback);
      const existing = inflight.find(key);
      if (existing) {
        res.locals.log = { mode: 'async', type: body.identityType, wallet: body.wallet, job: existing, deduplicated: true };
        res.status(202).json({ jobId: existing, status: 'proving', deduplicated: true, ...service.stats });
        return;
      }
      if (busy()) return void refuseBusy();
      const jobId = randomUUID();
      res.locals.log = { mode: 'async', type: body.identityType, wallet: body.wallet, job: jobId };
      void runWebhookJob(service, outbox, body, callback, jobId, { registry: inflight, key });
      res.status(202).json({ jobId, status: 'queued', ...service.stats });
      return;
    }
    if (busy()) return void refuseBusy();
    res.locals.log = { mode: 'sync', type: body.identityType, wallet: body.wallet };
    res.json(await service.generate(body));
  });

  /** Look up a callback job: its delivery state and, once proven, the attestation body. */
  app.get('/jobs/:id', auth, (req, res) => {
    const id = String(req.params.id);
    const job = outbox.get(id);
    if (!job) {
      // Accepted but not proven yet: it reaches the outbox together with its result.
      const proving = inflight.get(id);
      if (proving) res.json({ jobId: id, status: 'proving', startedAt: proving.startedAt });
      else res.status(404).json({ error: 'unknown job' });
      return;
    }
    const { body, ...meta } = job;
    res.json({ ...meta, result: JSON.parse(body) });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof InputError) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof QueueFullError) {
      res.set('retry-after', '10').status(503).json({ error: err.message });
    } else if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.too.large') {
      res.status(413).json({ error: 'body too large' });
    } else if (err instanceof SyntaxError) {
      res.status(400).json({ error: 'invalid JSON' });
    } else {
      console.error('attestation failed:', (err as Error).message);
      res.status(500).json({ error: 'proof generation failed' });
    }
  });

  return app;
}
