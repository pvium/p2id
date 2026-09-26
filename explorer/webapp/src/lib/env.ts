import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address');
const url = z.url();

/**
 * Public configuration, validated once. NEXT_PUBLIC_ values are inlined at build time, so each is
 * read by its literal name.
 */
const schema = z.object({
  /** Which Pvium environment's factory (from the SDK) to derive against: mainnets or testnets. */
  NEXT_PUBLIC_P2ID_ENV: z.enum(['production', 'sandbox']).default('production'),
  /** Local testing only: derive against this factory instead of the one the SDK records. */
  NEXT_PUBLIC_P2ID_FACTORY_OVERRIDE: address.optional(),
  /** Where "Claim with Pvium" points; the button is hidden when unset. */
  NEXT_PUBLIC_PVIUM_URL: url.optional(),
  /** The P2ID specification. */
  NEXT_PUBLIC_SPEC_URL: url.default('https://github.com/pvium/zkid/blob/main/P2ID.md'),
});

const blankToUndefined = (v: string | undefined) => (v === undefined || v.trim() === '' ? undefined : v.trim());

export const env = schema.parse({
  NEXT_PUBLIC_P2ID_ENV: blankToUndefined(process.env.NEXT_PUBLIC_P2ID_ENV),
  NEXT_PUBLIC_P2ID_FACTORY_OVERRIDE: blankToUndefined(process.env.NEXT_PUBLIC_P2ID_FACTORY_OVERRIDE),
  NEXT_PUBLIC_PVIUM_URL: blankToUndefined(process.env.NEXT_PUBLIC_PVIUM_URL),
  NEXT_PUBLIC_SPEC_URL: blankToUndefined(process.env.NEXT_PUBLIC_SPEC_URL),
});
