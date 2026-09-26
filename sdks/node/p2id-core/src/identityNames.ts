import { IdentityType } from './identity.js';

/** P2ID type names (the URI names in P2ID.md). */
export const P2ID_TYPE_NAMES = {
  email: IdentityType.Email,
  phone: IdentityType.Phone,
  google: IdentityType.Google,
  x: IdentityType.X,
  discord: IdentityType.Discord,
  github: IdentityType.Github,
  linkedin: IdentityType.Linkedin,
  apple: IdentityType.Apple,
  telegram: IdentityType.Telegram,
  tiktok: IdentityType.Tiktok,
  instagram: IdentityType.Instagram,
  farcaster: IdentityType.Farcaster,
  wallet: IdentityType.Wallet,
} as const;

/** Every accepted name: the P2ID names, `twitter`, and Privy's `linked_accounts[].type` strings. */
export const IDENTITY_TYPE_BY_NAME = {
  ...P2ID_TYPE_NAMES,
  twitter: IdentityType.Twitter,
  google_oauth: IdentityType.Google,
  twitter_oauth: IdentityType.Twitter,
  discord_oauth: IdentityType.Discord,
  github_oauth: IdentityType.Github,
  linkedin_oauth: IdentityType.Linkedin,
  apple_oauth: IdentityType.Apple,
  tiktok_oauth: IdentityType.Tiktok,
  instagram_oauth: IdentityType.Instagram,
} as const;

export type P2IDTypeName = keyof typeof P2ID_TYPE_NAMES;

/** The P2ID name of a type, e.g. IdentityType.Twitter -> "x". */
export function identityTypeName(type: IdentityType): P2IDTypeName {
  const entry = (Object.entries(P2ID_TYPE_NAMES) as [P2IDTypeName, IdentityType][]).find(([, id]) => id === type);
  if (!entry) throw new Error(`unknown identity type id ${type}`);
  return entry[0];
}

export type IdentityTypeName = keyof typeof IDENTITY_TYPE_BY_NAME;

export function resolveIdentityType(t: IdentityType | IdentityTypeName): IdentityType {
  if (typeof t === 'number') {
    if (!Object.values(IDENTITY_TYPE_BY_NAME).includes(t)) throw new Error(`unknown identity type id ${t}`);
    return t;
  }
  const id = IDENTITY_TYPE_BY_NAME[t];
  if (id === undefined) throw new Error(`unknown identity type "${t}"`);
  return id;
}
