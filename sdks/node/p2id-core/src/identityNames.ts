import { IdentityType, assertIdentityTypeSupported } from './identity.js';

/** P2ID type names (the URI names in P2ID.md). */
export const P2ID_TYPE_NAMES = {
  email: IdentityType.Email,
  phone: IdentityType.Phone,
  /** @deprecated Use email. Retained to identify legacy type IDs. */
  google: IdentityType.Google,
  x: IdentityType.X,
  discord: IdentityType.Discord,
  github: IdentityType.Github,
  /** @deprecated Use email. Retained to identify legacy type IDs. */
  linkedin: IdentityType.Linkedin,
  /** @deprecated Use email. Retained to identify legacy type IDs. */
  apple: IdentityType.Apple,
  telegram: IdentityType.Telegram,
  tiktok: IdentityType.Tiktok,
  instagram: IdentityType.Instagram,
  farcaster: IdentityType.Farcaster,
  wallet: IdentityType.Wallet,
} as const;

/**
 * Known names, including deprecated types, plus `twitter` (an alias of `x`).
 * resolveIdentityType rejects deprecated names and IDs for new identity generation. P2ID core is
 * agnostic of any identity provider — it does not know Privy (or any other verifier's) account
 * types. Callers map their provider's account types to these names themselves.
 */
export const IDENTITY_TYPE_BY_NAME = {
  ...P2ID_TYPE_NAMES,
  twitter: IdentityType.Twitter,
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
    assertIdentityTypeSupported(t);
    return t;
  }
  const id = IDENTITY_TYPE_BY_NAME[t];
  if (id === undefined) throw new Error(`unknown identity type "${t}"`);
  assertIdentityTypeSupported(id);
  return id;
}
