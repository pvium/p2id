'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import type { TopProfile } from '@/lib/home-highlights';
import { explorePath, PLATFORMS, PLATFORM_KEYS, type Platform } from '@/lib/p2id/constants';
import { Icon } from './Icon';
import { PlatformIcon } from './PlatformIcon';
import { TokenArt } from './TokenArt';
import styles from './TopProfiles.module.css';

const PAGE_SIZE = 2;

function ProfileCover({ art }: { art: string }) {
  return <div className={styles.cover} data-art={art} aria-hidden="true">
    <svg viewBox="0 0 600 220" preserveAspectRatio="xMidYMid slice">
      <path d="M0 55h600M0 110h600M0 165h600M75 0v220M150 0v220M225 0v220M300 0v220M375 0v220M450 0v220M525 0v220" fill="none" stroke="currentColor" strokeOpacity=".12" />
      {art === 'night' ? <>
        <circle cx="412" cy="110" r="76" fill="currentColor" opacity=".85" />
        <circle cx="447" cy="83" r="67" fill="#1b2544" />
        <path d="m97 42 3 12 12 3-12 3-3 12-3-12-12-3 12-3zm444 101 3 12 12 3-12 3-3 12-3-12-12-3 12-3z" fill="currentColor" />
        <path d="M0 212 122 150l90 39 136-61 116 74 84-41 52 27v32H0Z" fill="#111827" />
      </> : art === 'cast' ? <g fill="none" stroke="currentColor" strokeWidth="18">
        <path d="M225 260V145a155 155 0 0 1 310 0v115" opacity=".3" />
        <path d="M263 260V145a117 117 0 0 1 234 0v115" opacity=".5" />
        <path d="M301 260V145a79 79 0 0 1 158 0v115" opacity=".9" />
      </g> : art === 'cat' ? <g fill="currentColor">
        <path d="M265 65h35v35h35v35h-35v35h-35v-35h-35v-35h35zm180-75h55v55h55v55h-55v55h-55v-55h-55V45h55z" opacity=".5" />
        <path d="M420 160h25v25h25v25h-25v25h-25v-25h-25v-25h25zM110 45h15v15h15v15h-15v15h-15V75H95V60h15z" opacity=".85" />
      </g> : <g fill="none" stroke="currentColor">
        <ellipse cx="435" cy="122" rx="193" ry="68" transform="rotate(-28 435 122)" strokeWidth="2" opacity=".45" />
        <ellipse cx="435" cy="122" rx="155" ry="106" transform="rotate(-28 435 122)" strokeWidth="2" opacity=".3" />
        <circle cx="435" cy="122" r="83" fill="currentColor" opacity=".14" />
        <circle cx="435" cy="122" r="57" fill="currentColor" opacity=".22" />
        <circle cx="276" cy="151" r="9" fill="currentColor" stroke="none" />
      </g>}
    </svg>
    <span className={styles.coverLabel}>P2ID / COMMUNITY</span>
  </div>;
}

export function TopProfiles({ profiles, demo }: { profiles: TopProfile[]; demo: boolean }) {
  const titleId = useId();
  const [platform, setPlatform] = useState<Platform | 'all'>('all');
  const [page, setPage] = useState(0);
  const filtered = profiles.filter(profile => platform === 'all' || profile.platform === platform);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  function selectPlatform(nextPlatform: Platform | 'all') {
    setPlatform(nextPlatform);
    setPage(0);
  }

  return <section className={styles.section} aria-labelledby={titleId}>
    <div className={styles.heading}>
      <h2 id={titleId}>Top profiles{demo && <span className="sr-only"> (sample profiles)</span>}</h2>
      <div className={styles.pagination} role="group" aria-label="Profile pages">
        <button type="button" aria-label="Previous profile page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
          <Icon name="chevron" className={styles.previousIcon} />
        </button>
        <span aria-live="polite" aria-atomic="true"><span className="sr-only">Profile page </span>{currentPage + 1} / {pages}</span>
        <button type="button" aria-label="Next profile page" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}>
          <Icon name="chevron" className={styles.pageIcon} />
        </button>
      </div>
    </div>

    <div className={styles.filters} role="group" aria-label="Filter top profiles by platform">
      <button type="button" aria-pressed={platform === 'all'} onClick={() => selectPlatform('all')}>All</button>
      {PLATFORM_KEYS.map(key => <button type="button" key={key} aria-pressed={platform === key} onClick={() => selectPlatform(key)}>
        <PlatformIcon platform={key} className={styles.filterIcon} />{PLATFORMS[key].label}
      </button>)}
    </div>

    <div className={styles.cards}>
      {visible.map(profile => <Link
        key={profile.id}
        href={explorePath(profile.platform, profile.handle)}
        className={styles.card}
        aria-label={`View ${profile.name}, @${profile.handle} on ${PLATFORMS[profile.platform].label}`}
      >
        <ProfileCover art={profile.art} />
        <div className={styles.body}>
          <div className={styles.identityTop}>
            <div className={styles.avatar} aria-hidden="true"><TokenArt kind={profile.art} label={profile.name} /></div>
            <span className={styles.profileType}><span />P2ID recipient</span>
            <Icon name="arrow" className={styles.profileArrow} />
          </div>
          <h3>{profile.name}<PlatformIcon platform={profile.platform} className={styles.nameIcon} /></h3>
          <p className={styles.handle}>@{profile.handle}</p>
          <div className={styles.stats}>
            <div className={styles.tokenCount}><strong>{profile.tokenCount}</strong><span>{profile.tokenCount === 1 ? 'Token' : 'Tokens'}</span></div>
            <div className={styles.deposits}>
              <div>{profile.deposits.length ? profile.deposits.map((deposit, index) => <strong key={`${deposit.symbol}-${index}`}>{deposit.amount} <small>{deposit.symbol}</small></strong>) : <strong>—</strong>}</div>
              <span>Deposited</span>
            </div>
          </div>
        </div>
      </Link>)}
      {!visible.length && <p className={styles.empty}>No profiles on {platform === 'all' ? 'these platforms' : PLATFORMS[platform].label} yet.</p>}
    </div>
  </section>;
}
