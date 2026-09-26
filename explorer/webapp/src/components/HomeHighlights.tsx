'use client';

import Link from 'next/link';
import { useState } from 'react';
import { TopProfiles } from './TopProfiles';
import { TokenArt } from './TokenArt';
import { PlatformIcon } from './PlatformIcon';
import { Icon } from './Icon';
import { explorePath, PLATFORMS, PLATFORM_KEYS, type Platform } from '@/lib/p2id/constants';
import type { TopProfile, TopToken } from '@/lib/home-highlights';
import styles from './HomeHighlights.module.css';

const PAGE_SIZE = 8;
const compactDollars = (amount: number) => `$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(amount)}`;

export function HomeHighlights({ tokens, profiles, demo }: { tokens: TopToken[]; profiles: TopProfile[]; demo: boolean }) {
  const [platform, setPlatform] = useState<Platform | 'all'>('all');
  const [page, setPage] = useState(0);
  const filtered = tokens.filter(token => platform === 'all' || token.recipient.platform === platform);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  if (!demo && tokens.length === 0 && profiles.length === 0) return null;

  return <section className={styles.section} aria-label="Top tokens and recipient profiles">
    {demo && <div className={styles.preview}><span className="preview-badge"><span />Preview data</span><span>Sample rankings, market caps and recipient totals.</span></div>}
    <div className={styles.columns}>
      <div className={styles.tokens}>
        <div className={styles.heading}>
          <h2>{demo ? 'Top tokens' : 'Featured tokens'}</h2>
          <div className={styles.pagination} aria-label="Top token pages">
            <button type="button" aria-label="Previous top tokens" disabled={page === 0} onClick={() => setPage(page - 1)}><Icon name="chevron" className="h-4 w-4 rotate-180" /></button>
            <span aria-live="polite">{page + 1} / {pageCount}</span>
            <button type="button" aria-label="Next top tokens" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}><Icon name="chevron" className="h-4 w-4" /></button>
          </div>
        </div>
        <div className={styles.filters} role="group" aria-label="Top tokens recipient platform">
          <button type="button" aria-pressed={platform === 'all'} onClick={() => { setPlatform('all'); setPage(0); }}>All platforms</button>
          {PLATFORM_KEYS.map(key => <button type="button" key={key} aria-pressed={platform === key} onClick={() => { setPlatform(key); setPage(0); }}><PlatformIcon platform={key} />{PLATFORMS[key].label}</button>)}
        </div>
        <div className={styles.grid}>
          {visible.map(token => <article className={styles.card} key={token.id}>
            <div className={styles.art}>
              <TokenArt kind={token.art} label={token.symbol} />
              <span className={styles.chain} aria-label="BNB Chain">◆</span>
              {token.age && <span className={styles.age}>{token.age}</span>}
              <Link className={styles.recipient} href={explorePath(token.recipient.platform, token.recipient.handle)} title={`${PLATFORMS[token.recipient.platform].label}: @${token.recipient.handle}`}>
                <span className={`platform-avatar platform-${token.recipient.platform}`}><PlatformIcon platform={token.recipient.platform} /></span>
                <span className={styles.handle}>@{token.recipient.handle}</span>
                <Icon name="chevron" className="h-3 w-3 shrink-0" />
              </Link>
            </div>
            <div className={styles.details}>
              <div className={styles.name}><h3 title={token.name}>{token.name}</h3><span>{token.symbol}</span></div>
              {token.marketCapUsd !== undefined ? <p className={styles.value}><strong>{compactDollars(token.marketCapUsd)}</strong><span>MC</span></p> : <div className={styles.deposits}><span>Deposited</span>{token.deposits.map((deposit, i) => <strong key={i}>{deposit.amount} {deposit.symbol}</strong>)}</div>}
            </div>
          </article>)}
        </div>
        {visible.length === 0 && <p className={styles.empty}>No tokens for this platform yet.</p>}
      </div>
      <TopProfiles profiles={profiles} demo={demo} />
    </div>
  </section>;
}
