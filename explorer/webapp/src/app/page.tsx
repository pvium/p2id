import { SetupButton } from '@/components/SiteHeader';
import { TokenFeed } from '@/components/TokenFeed';
import { HomeHighlights } from '@/components/HomeHighlights';
import { Icon } from '@/components/Icon';
import { PlatformIcon } from '@/components/PlatformIcon';
import { env } from '@/lib/env';
import { getTokens } from '@/lib/tokens';
import { getHomeHighlights } from '@/lib/home-highlights';

export default async function Home({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const [tokens, params] = await Promise.all([getTokens(), searchParams]);
  const query = typeof params.q === 'string' ? params.q : '';
  const highlights = getHomeHighlights(tokens);
  return <main id="main" className="explorer-main">
    <section className="explorer-hero">
      <div className="hero-copy">
        <p className="eyebrow"><span className="status-dot" /> INTEGRATING WITH FOUR.MEME</p>
        <h1>Route four.meme fees<br className="sm:hidden" /> <span>to any @handle.</span></h1>
        <p>Launch your token on four.meme and route its fees to someone on X, Farcaster or Telegram.<br className="hidden sm:block" /> They sign in to claim through P2ID. You don’t need their wallet address.</p>
        <div className="hero-platforms"><span>Built for your people on</span><span><PlatformIcon platform="x" /> X</span><span><PlatformIcon platform="farcaster" /> Farcaster</span><span><PlatformIcon platform="telegram" /> Telegram</span></div>
      </div>
      <div className="hero-action"><SetupButton>Find a fee address <Icon name="arrow" /></SetupButton><span>No wallet address needed.</span></div>
    </section>
    <HomeHighlights {...highlights} />
    <TokenFeed feed={tokens} key={query} initialQuery={query} showSpotlight={false} />
    <section id="claim" className="claim-strip">
      <div className="claim-icon"><Icon name="wallet" className="h-6 w-6" /></div>
      <div><h2>Your handle. Your fees.</h2><p>Sign in with the recipient account to claim funds from its vault.</p></div>
      {env.NEXT_PUBLIC_PVIUM_URL ? <a href={env.NEXT_PUBLIC_PVIUM_URL} className="button-secondary">Claim fees <Icon name="arrow" /></a> : <span className="quiet-pill">Claiming opens at launch</span>}
    </section>
    <footer className="explorer-footer"><span><strong>p2id</strong> Token fees to any @handle.</span><a href={env.NEXT_PUBLIC_SPEC_URL} target="_blank" rel="noopener noreferrer">Protocol & docs ↗</a></footer>
  </main>;
}
