'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PlatformIcon } from './PlatformIcon';
import { Icon } from './Icon';
import { TokenArt } from './TokenArt';
import { CHAIN, explorePath, PLATFORMS, PLATFORM_KEYS, type Platform } from '@/lib/p2id/constants';
import type { TokenFeedData } from '@/lib/tokens';

type Token = TokenFeedData['items'][number];
const tokenKey = (token: Token) => 'id' in token ? token.id : token.address;
const artKind = (token: Token) => 'id' in token ? token.id : 'cast';

export function TokenFeed({ feed, recipient = false, initialQuery = '', showSpotlight = true }: { feed: TokenFeedData; recipient?: boolean; initialQuery?: string; showSpotlight?: boolean }) {
  const [query, setQuery] = useState(initialQuery);
  const [platform, setPlatform] = useState<Platform | 'all'>('all');
  const [sort, setSort] = useState('featured');
  const demo = feed.status === 'demo';
  const search = query.trim().toLowerCase().replace(/^@/, '');
  const filtered = feed.items.filter(token => (platform === 'all' || token.recipient.platform === platform)
    && [token.name, token.symbol, token.recipient.handle, 'address' in token ? token.address : ''].some(value => value.toLowerCase().includes(search)));
  if (sort === 'name') filtered.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === 'share') filtered.sort((a, b) => b.allocationPercent - a.allocationPercent);

  return <div className="token-explorer">
    {showSpotlight && !recipient && feed.items.length > 0 && <section className="spotlight-section" aria-label="Featured tokens">
      <div className="section-heading"><h2><Icon name="spark" className="h-4 w-4 text-accent" /> In the spotlight</h2><a href="#tokens">View all <Icon name="arrow" className="h-4 w-4" /></a></div>
      <div className="spotlight-row">{feed.items.slice(0, 4).map(token => <Link key={tokenKey(token)} href={explorePath(token.recipient.platform, token.recipient.handle)} className="spotlight-card">
        <div className="spotlight-art"><TokenArt kind={artKind(token)} label={token.symbol} /></div>
        <div className="spotlight-name"><strong>{token.name}</strong><span>${token.symbol}</span></div>
        <div className="spotlight-amount"><span>{demo ? 'SAMPLE DEPOSITS' : 'DEPOSITED'}</span><strong>{token.deposits[0]?.amount || '0'} <small>{token.deposits[0]?.symbol || ''}</small></strong></div>
      </Link>)}</div>
    </section>}

    <section id="tokens">
      <div className="section-heading launches-heading"><h2>{recipient ? 'Tokens paying this handle' : 'Explore tokens'}<span className="count-badge">{feed.items.length}</span></h2>{demo && <span className="preview-badge"><span />Preview data</span>}</div>
      <div className="explorer-controls">
        <div className="filter-tabs" role="group" aria-label="Filter by recipient platform">
          <button type="button" aria-pressed={platform === 'all'} onClick={() => setPlatform('all')}>All platforms</button>
          {PLATFORM_KEYS.map(key => <button type="button" key={key} aria-pressed={platform === key} onClick={() => setPlatform(key)}><PlatformIcon platform={key} />{PLATFORMS[key].label}</button>)}
        </div>
        <div className="feed-search"><Icon name="search" /><label htmlFor="token-search" className="sr-only">Filter tokens</label><input id="token-search" type="search" placeholder="Token, @handle or address" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <label className="sort-control"><span className="sr-only">Sort tokens</span><select value={sort} onChange={e => setSort(e.target.value)}><option value="featured">Featured</option><option value="name">Name: A–Z</option><option value="share">Fee share</option></select></label>
      </div>
      {filtered.length ? <div className="token-grid">{filtered.map(token => <article key={tokenKey(token)} className="token-card">
        <div className="token-image">
          <TokenArt kind={artKind(token)} label={token.symbol} />
          <span className="network-badge"><span className="network-diamond">◆</span> BNB Chain</span>
          <span className="allocation-badge">{token.allocationPercent}% to recipient</span>
          <Link href={explorePath(token.recipient.platform, token.recipient.handle)} className="recipient-badge"><span className={`platform-avatar platform-${token.recipient.platform}`}><PlatformIcon platform={token.recipient.platform} /></span><span className="sr-only">{PLATFORMS[token.recipient.platform].label} </span>@{token.recipient.handle}<Icon name="chevron" className="h-3 w-3" /></Link>
        </div>
        <div className="token-card-body">
          <div className="token-title"><h3>{token.name}</h3><span>${token.symbol}</span></div>
          <div className="deposit-row"><span>Deposited to vault</span><div>{token.deposits.length ? token.deposits.map((deposit, i) => <strong key={i}>{deposit.amount} <small>{deposit.symbol}</small></strong>) : <strong>—</strong>}</div></div>
          <div className="token-card-footer">
            <Link href={explorePath(token.recipient.platform, token.recipient.handle)}>{demo ? 'View recipient' : 'Recipient & deposits'} <Icon name="arrow" className="h-3.5 w-3.5" /></Link>
            {'address' in token ? <a href={`${CHAIN.explorerOrigin}/token/${token.address}`} target="_blank" rel="noopener noreferrer" aria-label={`View ${token.name} on BscScan`}><Icon name="link" className="h-4 w-4" /></a> : <span>Sample</span>}
          </div>
        </div>
      </article>)}</div> : <div className="feed-empty"><Icon name="search" className="h-7 w-7" /><h3>{feed.status === 'unavailable' ? 'Activity is temporarily unavailable' : 'No tokens found'}</h3><p>{feed.status === 'unavailable' ? 'Please try again shortly. This does not mean funds are missing.' : 'Try a different token, handle or platform.'}</p>{(query || platform !== 'all') && <button type="button" className="button-secondary" onClick={() => { setQuery(''); setPlatform('all'); }}>Clear filters</button>}</div>}
      <p className="feed-note">{demo ? 'Preview only. Tokens, affiliations and amounts are illustrative.' : 'Deposits show funds delivered to a vault, not its current balance.'} Naming a recipient does not imply endorsement.</p>
    </section>
  </div>;
}
