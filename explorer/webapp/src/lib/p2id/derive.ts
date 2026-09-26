import { p2idAddress, p2idScheme } from '@pvium/p2id-core';
import { env } from '../env';
import { PLATFORMS, type Platform } from './constants';

/**
 * The factory addresses are derived against: the one the P2ID SDK records for the current scheme
 * and NEXT_PUBLIC_P2ID_ENV, unless a local-testing override is set. Null while the SDK has none
 * recorded (before the first deployment), in which case the site shows no addresses.
 */
export function configuredFactory(): `0x${string}` | null {
  if (env.NEXT_PUBLIC_P2ID_FACTORY_OVERRIDE) return env.NEXT_PUBLIC_P2ID_FACTORY_OVERRIDE as `0x${string}`;
  return p2idScheme().factories[env.NEXT_PUBLIC_P2ID_ENV];
}

/** The P2ID for a handle, from the P2ID SDK; null when there is no factory yet. */
export async function deriveP2ID(platform: Platform, handle: string, factory: string | null): Promise<`0x${string}` | null> {
  if (!factory) return null;
  return p2idAddress({
    identityType: PLATFORMS[platform].identityType,
    identityValue: handle,
    factory: factory as `0x${string}`,
  });
}
