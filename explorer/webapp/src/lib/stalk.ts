import { z } from 'zod';
import { handleSchemas } from './p2id/handles';
import { PLATFORM_KEYS } from './p2id/constants';

const isEmail = (v: string) => z.email().safeParse(v).success;
const isTelegram = (v: string) => /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v);

/** Where to ping a stalker: an email address or a Telegram username. */
export const contactSchema = z
  .string()
  .trim()
  .min(1, 'Tell us where to ping you')
  .transform((v) => v.replace(/^@/, ''))
  .refine((v) => isEmail(v) || isTelegram(v), 'Enter an email or a Telegram @username');

/** A request to be notified whenever a handle's P2ID gets paid. */
export const stalkRequestSchema = z
  .object({
    platform: z.enum(PLATFORM_KEYS as ['x', 'farcaster', 'telegram']),
    handle: z.string(),
    contact: contactSchema,
  })
  .superRefine((v, ctx) => {
    const r = handleSchemas[v.platform].safeParse(v.handle);
    if (!r.success) ctx.addIssue({ code: 'custom', path: ['handle'], message: r.error.issues[0]?.message ?? 'Invalid handle' });
  })
  .transform((v) => ({ ...v, handle: handleSchemas[v.platform].parse(v.handle) }));

export type StalkRequest = z.infer<typeof stalkRequestSchema>;
