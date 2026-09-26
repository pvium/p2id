import { z } from 'zod';
import { PLATFORM_KEYS } from './p2id/constants';

/** One payment received by a handle's P2ID, as the explorer API reports it. */
export const payoutSchema = z.object({
  platform: z.enum(PLATFORM_KEYS as [string, ...string[]]),
  handle: z.string().min(1).max(64),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /** Human-readable amount, e.g. "0.2". */
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  symbol: z.string().min(1).max(12),
  chainId: z.number().int().positive(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
});
export type Payout = z.infer<typeof payoutSchema> & { platform: 'x' | 'farcaster' | 'telegram' };

const recentSchema = z.object({ items: z.array(payoutSchema).max(50) });

/**
 * Shown only until the explorer API is live, and always labelled as examples on the page.
 * Addresses and amounts are illustrative; they are not real payouts.
 */
const EXAMPLE_PAYOUTS: Payout[] = [
  { platform: 'x', handle: 'junni', address: '0x0230a91f5c2d6b8e4f17c3a9d0b2e6f8a1c40909', amount: '0.2', symbol: 'BNB', chainId: 56 },
  { platform: 'telegram', handle: 'andi', address: '0x38328c4e0b7a1d5f9e2c6a8b3d0f4e7c1a9b5d62', amount: '0.12', symbol: 'BNB', chainId: 56 },
  { platform: 'farcaster', handle: 'frogdad', address: '0x7a1b9e4c2d8f6a0b3e5c7d1f9a2b4c6e8d0f1a33', amount: '0.45', symbol: 'BNB', chainId: 56 },
  { platform: 'x', handle: 'degen_sensei', address: '0x5c2a4b8d1e7f3a9c6b0d2e4f8a1c3e5b7d9f0e71', amount: '1.08', symbol: 'BNB', chainId: 56 },
  { platform: 'telegram', handle: 'mooncalls', address: '0x9e4d2b6f0a8c1e3d5b7f9a2c4e6b8d0f1a3c5e14', amount: '0.07', symbol: 'BNB', chainId: 56 },
  { platform: 'x', handle: 'wenlambo', address: '0x1f8c3a5e7b9d0f2a4c6e8b1d3f5a7c9e0b2d4f86', amount: '0.33', symbol: 'BNB', chainId: 56 },
  { platform: 'farcaster', handle: 'bnb-intern', address: '0x4b6d8f0a2c4e6b8d0f1a3c5e7b9d1f3a5c7e9b20', amount: '0.19', symbol: 'BNB', chainId: 56 },
];

export type RecentPayouts = { items: Payout[]; examples: boolean };

/**
 * Recent payouts from the explorer API (P2ID_API_URL). Falls back to clearly labelled examples
 * when the API is not configured, unreachable, or has nothing yet.
 */
export async function getRecentPayouts(): Promise<RecentPayouts> {
  const api = process.env.P2ID_API_URL;
  if (api) {
    try {
      const res = await fetch(new URL('/payouts/recent', api), { next: { revalidate: 60 } });
      if (res.ok) {
        const parsed = recentSchema.safeParse(await res.json());
        if (parsed.success && parsed.data.items.length > 0) return { items: parsed.data.items as Payout[], examples: false };
      }
    } catch {
      // fall through to examples
    }
  }
  return { items: EXAMPLE_PAYOUTS, examples: true };
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-3)}`;
}
