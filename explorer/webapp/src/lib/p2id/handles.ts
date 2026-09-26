import { z } from 'zod';
import type { Platform } from './constants';

/** Accept "@name", "name", or a pasted profile URL; return the bare handle. */
function strip(input: string, hosts: string[], reservedPaths: string[] = []): string {
  let v = input.trim();
  for (const host of hosts) {
    const m = v.match(new RegExp(`^(?:https?://)?(?:www\\.)?${host.replace('.', '\\.')}/([^/?#]+)/?(?:[?#].*)?$`, 'i'));
    // Only accept profile links, not platform navigation or nested action URLs.
    if (m && !reservedPaths.includes(m[1].toLowerCase())) v = m[1];
  }
  return v.replace(/^@/, '');
}

/** Handle formats as each platform allows them. Values are case-insensitive for P2ID purposes. */
export const handleSchemas = {
  // 1–15 letters, digits, underscores.
  x: z
    .string()
    .transform((v) => strip(v, ['x.com', 'twitter.com'], ['home', 'explore', 'search', 'notifications', 'messages', 'settings', 'i', 'intent', 'compose', 'share']))
    .pipe(z.string().regex(/^[A-Za-z0-9_]{1,15}$/, 'X handles are 1–15 letters, numbers or underscores')),
  // Farcaster fname (1–16 lowercase letters, digits, hyphens) or an ENS name ending in .eth.
  farcaster: z
    .string()
    .transform((v) => strip(v, ['farcaster.xyz', 'warpcast.com']).toLowerCase())
    .pipe(
      z
        .string()
        .regex(
          /^(?:[a-z0-9][a-z0-9-]{0,15}|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth)$/,
          'Farcaster names are 1–16 lowercase letters, numbers or hyphens, or an ENS name',
        ),
    ),
  // 5–32 letters, digits, underscores, starting with a letter.
  telegram: z
    .string()
    .transform((v) => strip(v, ['t.me', 'telegram.me'], ['share', 'joinchat', 'addstickers', 'addemoji', 'proxy', 'socks', 'login', 'iv', 's']))
    .pipe(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{4,31}$/, 'Telegram usernames are 5–32 letters, numbers or underscores')),
} satisfies Record<Platform, z.ZodType<string, string>>;

export type HandleResult = { ok: true; handle: string } | { ok: false; error: string };

export function parseHandle(platform: Platform, input: string): HandleResult {
  const r = handleSchemas[platform].safeParse(input);
  return r.success ? { ok: true, handle: r.data } : { ok: false, error: r.error.issues[0]?.message ?? 'Invalid handle' };
}
