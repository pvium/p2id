import { env } from '../env';

// Site-level P2ID settings. The address derivation itself comes from the P2ID SDK
// (@pvium/p2id-core), so the site can never disagree with the protocol.

import { IdentityType } from '@pvium/p2id-core';

/** Social platforms the site supports, keyed by their URL segment. */
export const PLATFORMS = {
  x: { label: 'X', short: 'x', identityType: IdentityType.X, profileUrl: (h: string) => `https://x.com/${h}` },
  farcaster: { label: 'Farcaster', short: 'fc', identityType: IdentityType.Farcaster, profileUrl: (h: string) => `https://farcaster.xyz/${h}` },
  telegram: { label: 'Telegram', short: 't', identityType: IdentityType.Telegram, profileUrl: (h: string) => `https://t.me/${h}` },
} as const;

export type Platform = keyof typeof PLATFORMS;
export const PLATFORM_KEYS = Object.keys(PLATFORMS) as Platform[];

export function isPlatform(v: string): v is Platform {
  return Object.hasOwn(PLATFORMS, v);
}

/**
 * The chain this product runs on: four.meme is on BNB Chain, so everything the site shows is BNB
 * Chain. (The P2ID protocol itself is multi-chain; that belongs in the spec, not on this site.)
 */
const sandbox = env.NEXT_PUBLIC_P2ID_ENV === 'sandbox';
const explorerOrigin = sandbox ? 'https://testnet.bscscan.com' : 'https://bscscan.com';
export const CHAIN = {
  name: sandbox ? 'BNB Chain testnet' : 'BNB Chain',
  chainId: sandbox ? 97 : 56,
  explorerName: 'BscScan',
  explorerOrigin,
  addressUrl: (a: string) => `${explorerOrigin}/address/${a}`,
} as const;

/** Explorer page for a handle on this site. */
export function explorePath(platform: Platform, handle: string): `/${string}` {
  return `/${platform}/${handle.toLowerCase()}`;
}
