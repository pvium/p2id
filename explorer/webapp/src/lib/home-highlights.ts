import type { Platform } from './p2id/constants';
import type { TokenFeedData } from './tokens';

export type TopProfile = {
  id: string;
  name: string;
  platform: Platform;
  handle: string;
  art: string;
  tokenCount: number;
  deposits: { amount: string; symbol: string }[];
};
export type TopToken = {
  id: string;
  name: string;
  symbol: string;
  art: string;
  recipient: { platform: Platform; handle: string };
  deposits: { amount: string; symbol: string }[];
  marketCapUsd?: number;
  age?: string;
};

const profiles: TopProfile[] = [
  { id: 'lilypad', name: 'Lily Pad Club', platform: 'x', handle: 'lilypadclub', art: 'frog', tokenCount: 128, deposits: [{ amount: '42.86', symbol: 'WBNB' }] },
  { id: 'castaway', name: 'Castaway', platform: 'farcaster', handle: 'castaway', art: 'cast', tokenCount: 93, deposits: [{ amount: '31.42', symbol: 'WBNB' }] },
  { id: 'midnight', name: 'Midnight Memos', platform: 'telegram', handle: 'midnightmemos', art: 'night', tokenCount: 76, deposits: [{ amount: '18420.50', symbol: 'USDT' }] },
  { id: 'catdispatch', name: 'Cat Dispatch', platform: 'x', handle: 'catdispatch', art: 'cat', tokenCount: 61, deposits: [{ amount: '19.73', symbol: 'WBNB' }] },
  { id: 'bean', name: 'Build With Bean', platform: 'farcaster', handle: 'buildwithbean', art: 'coffee', tokenCount: 48, deposits: [{ amount: '9875.00', symbol: 'USDT' }] },
  { id: 'goose', name: 'Goose on Chain', platform: 'telegram', handle: 'gooseonchain', art: 'goose', tokenCount: 32, deposits: [{ amount: '8.64', symbol: 'WBNB' }] },
];

const extras = [
  { name: 'The Lily Pad', symbol: 'LILY', art: 'frog' },
  { name: 'Purple Hour', symbol: 'PURPLE', art: 'cast' },
  { name: 'Moon Mail', symbol: 'MAIL', art: 'night' },
  { name: 'Nine Lives Club', symbol: 'NINE', art: 'cat' },
  { name: 'Proof of Coffee', symbol: 'POC', art: 'coffee' },
  { name: 'Honk If You Hold', symbol: 'HOLD', art: 'goose' },
];
const caps = [469500, 187200, 92300, 67100, 48600, 32400, 24900, 17800, 12500, 9400, 7600, 5200];
const ages = ['43m', '1h', '2h', '3h', '5h', '8h', '12h', '16h', '1d', '2d', '3d', '4d'];

/** Rich preview data is separate from live indexing; never attach invented market values to live tokens. */
export function getHomeHighlights(feed: TokenFeedData): { tokens: TopToken[]; profiles: TopProfile[]; demo: boolean } {
  if (feed.status === 'demo') {
    const base = feed.items.map((token, index) => ({
      id: token.id, name: token.name, symbol: token.symbol, art: token.id,
      recipient: token.recipient, deposits: token.deposits, marketCapUsd: caps[index], age: ages[index],
    }));
    const more = extras.map((token, index) => ({ ...token, id: `extra-${token.symbol}`, recipient: profiles[index],
      deposits: [{ amount: (0.8 - index * 0.1).toFixed(2), symbol: 'WBNB' }],
      marketCapUsd: caps[index + 6], age: ages[index + 6],
    }));
    return { tokens: [...base, ...more], profiles, demo: true };
  }
  // Live feeds do not yet provide profile totals or comparable market values. Show the
  // supplied tokens without fabricating rankings, and leave the profile panel empty.
  return { tokens: feed.items.map(token => ({
    id: token.address, name: token.name, symbol: token.symbol, art: 'cast',
    recipient: token.recipient, deposits: token.deposits,
  })), profiles: [], demo: false };
}
