import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RecipientSetup } from '@/components/RecipientSetup';
import { TokenFeed } from '@/components/TokenFeed';
import { env } from '@/lib/env';
import { PLATFORMS, isPlatform } from '@/lib/p2id/constants';
import { configuredFactory, deriveP2ID } from '@/lib/p2id/derive';
import { parseHandle } from '@/lib/p2id/handles';
import { getTokens } from '@/lib/tokens';

async function resolve(params: Promise<{ platform: string; handle: string }>) {
  const { platform, handle } = await params;
  if (!isPlatform(platform)) notFound();
  const parsed = parseHandle(platform, handle);
  if (!parsed.ok) notFound();
  const normal = parsed.handle.toLowerCase();
  const address = await deriveP2ID(platform, normal, configuredFactory());
  return { platform, handle: normal, address };
}

export async function generateMetadata(props: PageProps<'/[platform]/[handle]'>): Promise<Metadata> {
  const { platform, handle } = await resolve(props.params);
  const title = `Fees for @${handle} · P2ID`;
  const description = `See tokens directing fees to ${PLATFORMS[platform].label} @${handle}, find their fee address and follow deposits to their vault.`;
  return { title, description, openGraph: { title, description, siteName: 'P2ID', type: 'website' } };
}

export default async function HandlePage(props: PageProps<'/[platform]/[handle]'>) {
  const { platform, handle, address } = await resolve(props.params);
  const tokens = await getTokens({ platform, handle });
  return <div className="min-h-full">
    <main id="main" className="profile-main">
      <div className="grid items-start gap-8 lg:grid-cols-2">
        <section className="profile-panel">
          <p className="text-xs font-extrabold uppercase tracking-widest">Recipient on {PLATFORMS[platform].label}</p>
          <h1 className="mt-4 break-words">Fees for<br /><span>@{handle}</span></h1>
          <a href={PLATFORMS[platform].profileUrl(handle)} target="_blank" rel="noopener noreferrer" className="mt-5 inline-block text-sm font-bold underline underline-offset-4">Check their {PLATFORMS[platform].label} profile ↗</a>
          <p className="mt-4 text-sm font-semibold text-ink/70">This page identifies a fee destination. It does not mean the account owner has joined P2ID or endorsed any listed token.</p>
          <div className="profile-claim mt-7 pt-6">
            <h2 className="font-display text-2xl">Is this your handle?</h2>
            <p className="mt-2 text-sm font-semibold">Sign in with this account to check and claim funds in its vault.</p>
            {env.NEXT_PUBLIC_PVIUM_URL ? <a href={env.NEXT_PUBLIC_PVIUM_URL} className="button-primary mt-4">Claim fees ↗</a> : <p className="mt-4 text-sm muted">Claiming opens at launch.</p>}
          </div>
        </section>
        <section className="profile-panel">
          <h2 className="mb-5 font-display text-2xl tracking-wide">Send token fees here.</h2>
          <RecipientSetup address={address} />
        </section>
      </div>
      <section className="mt-14">
        <h2 className="font-display text-3xl tracking-wide">Tokens paying @{handle}</h2>
        <p className="mt-3 mb-7 text-sm font-semibold">Amounts show recorded deposits, not a live spendable balance. Claimed funds and deposits are different.</p>
        <TokenFeed feed={tokens} recipient />
      </section>
    </main>
  </div>;
}
