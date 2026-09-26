import { z } from 'zod';
import { CHAIN, isPlatform, type Platform } from './p2id/constants';
import { configuredFactory, deriveP2ID } from './p2id/derive';
import { parseHandle } from './p2id/handles';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const amount = z.string().regex(/^\d+(\.\d+)?$/);
const tokenSchema = z.object({
  address,
  name: z.string().min(1).max(100),
  symbol: z.string().min(1).max(20),
  chainId: z.literal(CHAIN.chainId),
  recipient: z.object({
    platform: z.string().refine(isPlatform).transform((value) => value as Platform),
    handle: z.string().min(1).max(64),
    address,
  }),
  // Only the indexer may assert this, after checking on-chain fee configuration.
  routingVerified: z.literal(true),
  allocationPercent: z.number().positive().max(100),
  deposits: z.array(z.object({ amount, symbol: z.string().min(1).max(12) })).max(10),
  latestDepositTx: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
});
export type RoutedToken = z.infer<typeof tokenSchema>;
type DemoToken = Pick<RoutedToken, 'name' | 'symbol' | 'allocationPercent' | 'deposits'> & {
  id: string;
  emoji: string;
  recipient: { platform: Platform; handle: string };
};
export type TokenFeedData = { status: 'ready' | 'unavailable'; items: RoutedToken[] }
  | { status: 'demo'; items: DemoToken[] };

const DEMO_TOKENS: DemoToken[] = [
  { id: 'frog', emoji: '🐸', name: 'Frog With Benefits', symbol: 'FWB', recipient: { platform: 'x', handle: 'lilypadclub' }, allocationPercent: 100, deposits: [{ amount: '4.28', symbol: 'WBNB' }] },
  { id: 'cast', emoji: '🟣', name: 'One More Cast', symbol: 'CAST', recipient: { platform: 'farcaster', handle: 'castaway' }, allocationPercent: 100, deposits: [{ amount: '2.16', symbol: 'WBNB' }] },
  { id: 'night', emoji: '🌙', name: 'Night Shift', symbol: 'NIGHT', recipient: { platform: 'telegram', handle: 'midnightmemos' }, allocationPercent: 80, deposits: [{ amount: '875.50', symbol: 'USDT' }] },
  { id: 'cat', emoji: '🐈', name: 'Cat Distribution System', symbol: 'CDS', recipient: { platform: 'x', handle: 'catdispatch' }, allocationPercent: 100, deposits: [{ amount: '1.73', symbol: 'WBNB' }] },
  { id: 'coffee', emoji: '☕', name: 'Buy The Dev A Coffee', symbol: 'BREW', recipient: { platform: 'farcaster', handle: 'buildwithbean' }, allocationPercent: 50, deposits: [{ amount: '342.00', symbol: 'USDT' }] },
  { id: 'goose', emoji: '🪿', name: 'The Goose Is Loose', symbol: 'HONK', recipient: { platform: 'telegram', handle: 'gooseonchain' }, allocationPercent: 100, deposits: [{ amount: '0.64', symbol: 'WBNB' }] },
];

function demoFeed(recipient?: { platform: Platform; handle: string }): TokenFeedData {
  return { status: 'demo', items: recipient
    ? DEMO_TOKENS.slice(0, 3).map((token) => ({ ...token, recipient }))
    : DEMO_TOKENS };
}

/** Preview content without an indexer; configured feeds retain genuine empty/error states. */
export async function getTokens(recipient?: { platform: Platform; handle: string }): Promise<TokenFeedData> {
  const api = process.env.P2ID_API_URL;
  if (!api) return demoFeed(recipient);
  try {
    const url = new URL('/tokens', api);
    if (recipient) {
      url.searchParams.set('platform', recipient.platform);
      url.searchParams.set('handle', recipient.handle);
    }
    const response = await fetch(url, { next: { revalidate: 60 }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { status: 'unavailable', items: [] };
    const body = z.object({ items: z.array(z.unknown()).max(50) }).parse(await response.json());
    const factory = configuredFactory();
    const items: RoutedToken[] = [];
    for (const raw of body.items) {
      const parsed = tokenSchema.safeParse(raw);
      if (!parsed.success) continue;
      const token = parsed.data;
      const handle = parseHandle(token.recipient.platform, token.recipient.handle);
      if (!handle.ok) continue;
      token.recipient.handle = handle.handle.toLowerCase();
      if (recipient && (token.recipient.platform !== recipient.platform || token.recipient.handle !== recipient.handle.toLowerCase())) continue;
      const derived = await deriveP2ID(token.recipient.platform, token.recipient.handle, factory);
      if (!derived || derived.toLowerCase() !== token.recipient.address.toLowerCase()) continue;
      if (items.some((item) => item.address.toLowerCase() === token.address.toLowerCase())) continue;
      items.push(token);
    }
    return { status: 'ready', items };
  } catch {
    return { status: 'unavailable', items: [] };
  }
}
