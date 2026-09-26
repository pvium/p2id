'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CHAIN, PLATFORMS, PLATFORM_KEYS, explorePath, type Platform } from '@/lib/p2id/constants';
import { deriveP2ID } from '@/lib/p2id/derive';
import { parseHandle } from '@/lib/p2id/handles';
import { Icon } from './Icon';
import { PlatformIcon } from './PlatformIcon';
import styles from './RecipientSearch.module.css';

type Match = {
  platform: Platform;
  handle: string;
  address: `0x${string}` | null;
  status: 'loading' | 'ready' | 'error';
};

export function RecipientSearch({ factory }: { factory: string | null }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const dropdown = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const visible = open && query.trim().length > 0;

  useEffect(() => () => { ++request.current; }, []);

  useEffect(() => {
    const panel = dropdown.current;
    const option = panel?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!panel || !option) return;
    if (option.offsetTop < panel.scrollTop) panel.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > panel.scrollTop + panel.clientHeight) {
      panel.scrollTop = option.offsetTop + option.offsetHeight - panel.clientHeight;
    }
  }, [active, visible]);

  async function search(value: string) {
    const id = ++request.current;
    setQuery(value);
    setActive(-1);
    setOpen(value.trim().length > 0);
    const candidates: Match[] = PLATFORM_KEYS.flatMap((platform) => {
      const parsed = parseHandle(platform, value);
      return parsed.ok ? [{ platform, handle: parsed.handle.toLowerCase(), address: null, status: 'loading' as const }] : [];
    });
    setMatches(candidates);
    const resolved = await Promise.all(candidates.map(async (match): Promise<Match> => {
      try {
        return { ...match, address: await deriveP2ID(match.platform, match.handle, factory), status: 'ready' };
      } catch {
        return { ...match, status: 'error' };
      }
    }));
    if (request.current === id) setMatches(resolved);
  }

  function choose(match: Match) {
    setOpen(false);
    setActive(-1);
    input.current?.blur();
    router.push(explorePath(match.platform, match.handle));
  }

  return <form role="search" aria-label="Find a recipient" className={`global-search ${styles.search}`} onSubmit={(event) => {
    event.preventDefault();
    if (visible && active >= 0 && matches[active]) choose(matches[active]);
    else setOpen(query.trim().length > 0);
  }}>
    <Icon name="search" />
    <label htmlFor="global-search" className="sr-only">Search a recipient’s handle or profile link</label>
    <input ref={input} id="global-search" type="text" role="combobox" value={query}
      placeholder="Search a @handle" autoComplete="off" autoCapitalize="none" spellCheck={false}
      aria-autocomplete="list" aria-expanded={visible} aria-controls={visible ? 'recipient-results' : undefined}
      aria-activedescendant={visible && active >= 0 ? `recipient-result-${matches[active].platform}` : undefined}
      aria-describedby={visible ? 'recipient-search-help' : undefined}
      onChange={(event) => { void search(event.target.value); }}
      onFocus={() => setOpen(query.trim().length > 0)}
      onBlur={() => { setOpen(false); setActive(-1); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') {
          event.preventDefault(); setOpen(false); setActive(-1);
        } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) {
          event.preventDefault();
          setOpen(true);
          setActive((previous) => event.key === 'ArrowDown'
            ? (previous + 1) % matches.length
            : (previous <= 0 ? matches.length - 1 : previous - 1));
        }
      }} />
    <kbd aria-hidden="true">↵</kbd>
    {visible && <div ref={dropdown} className={styles.dropdown}>
      <div className={styles.heading}><span>Choose a platform</span><span>{CHAIN.name}</span></div>
      <ul id="recipient-results" role="listbox" aria-label="Recipient fee addresses">
        {matches.map((match, index) => <li key={match.platform} id={`recipient-result-${match.platform}`}
          role="option" aria-selected={active === index} className={styles.option}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => choose(match)}>
          <span className={styles.platformIcon} data-platform={match.platform}><PlatformIcon platform={match.platform} /></span>
          <span className={styles.identity}><span>{PLATFORMS[match.platform].label}</span><strong>@{match.handle}</strong></span>
          <span className={styles.destination}>
            <span>Fee address</span>
            {match.address
              ? <code title={match.address} aria-label={match.address}>{match.address.slice(0, 8)}…{match.address.slice(-6)}</code>
              : <span className={styles.unavailable}>{match.status === 'loading' ? 'Deriving…' : match.status === 'error' ? 'Address unavailable' : 'Available at launch'}</span>}
          </span>
          <span className={styles.arrow} aria-hidden="true">↗</span>
        </li>)}
      </ul>
      {!matches.length && <p className={styles.empty}>Enter a valid X, Farcaster or Telegram handle, or paste a profile link.</p>}
      <p id="recipient-search-help" className={styles.help}>Select a platform to view the recipient.</p>
    </div>}
    <span role="status" className="sr-only">{visible ? matches.length ? `${matches.length} platform matches. Use the arrow keys to choose a platform, then press Enter.` : 'No valid platform matches.' : ''}</span>
  </form>;
}
