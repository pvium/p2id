import { createApp } from './app.js';
import { configFromEnv } from './config.js';

const cfg = configFromEnv();
let app;
try {
  app = createApp(cfg, process.env.AUTH_TOKEN ?? '');
} catch (e) {
  console.error(`startup failed: ${(e as Error).message}`);
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8787);
// Solana: fetch the keys if needed and load the proving key into the resident prover before taking
// requests, so a wrong key or binary fails the deploy's health check, not a user's request.
try {
  await app.locals.service.startSolana();
} catch (e) {
  console.error(`startup failed: ${(e as Error).message}`);
  process.exit(1);
}
const server = app.listen(port, () => console.log(`pvium prover listening on :${port} (max ${cfg.maxConcurrency} concurrent proves)`));
server.requestTimeout = 300_000; // a queued prove can wait a while
