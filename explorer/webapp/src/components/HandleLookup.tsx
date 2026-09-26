'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { RecipientSetup } from '@/components/RecipientSetup';
import { PlatformIcon } from '@/components/PlatformIcon';
import { PLATFORMS, PLATFORM_KEYS, explorePath, type Platform } from '@/lib/p2id/constants';
import { deriveP2ID } from '@/lib/p2id/derive';
import { parseHandle } from '@/lib/p2id/handles';

type Result = { platform: Platform; handle: string; address: `0x${string}` | null };

export function HandleLookup({ factory }: { factory: string | null }) {
  const [platform, setPlatform] = useState<Platform>('x');
  const [input, setInput] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const request = useRef(0);

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    const id = ++request.current;
    setResult(null);
    setConfirmed(false);
    setError(null);
    const parsed = parseHandle(platform, input);
    if (!parsed.ok) { setError(parsed.error); return; }
    setPending(true);
    try {
      const handle = parsed.handle.toLowerCase();
      const address = await deriveP2ID(platform, handle, factory);
      if (request.current === id) setResult({ platform, handle, address });
    } catch {
      if (request.current === id) setError('We couldn’t find the address. Please try again.');
    } finally {
      if (request.current === id) setPending(false);
    }
  }

  return <div className="lookup-panel">
    <p className="lookup-eyebrow">FIND A FEE ADDRESS</p>
    <h2 className="mt-3">Who should get the fees?</h2>
    <p className="mt-3 text-sm muted">Choose a platform, then enter their handle or profile link.</p>
    <div role="group" aria-label="Recipient platform" className="mt-5 grid grid-cols-3 gap-2">
      {PLATFORM_KEYS.map((key) => <button key={key} type="button" aria-pressed={platform === key} onClick={() => {
        ++request.current; setPlatform(key); setInput(''); setResult(null); setConfirmed(false); setError(null); setPending(false);
      }} className="lookup-platform flex min-w-0 items-center justify-center gap-1.5 px-2 py-3 text-xs font-medium sm:text-sm">
        <PlatformIcon platform={key} className="h-4 w-4 shrink-0" />{PLATFORMS[key].label}
      </button>)}
    </div>
    <form onSubmit={lookup} className="mt-6">
      <label htmlFor="handle" className="mb-2 block text-sm font-bold">Recipient’s {PLATFORMS[platform].label} handle</label>
      <input id="handle" value={input} onChange={(e) => {
        ++request.current; setInput(e.target.value); setResult(null); setConfirmed(false); setError(null); setPending(false);
      }} placeholder="@someone" autoComplete="off" spellCheck={false} aria-invalid={!!error} aria-describedby={error ? 'lookup-error' : undefined}
        className="w-full px-4 py-3 text-base" />
      <button disabled={pending} className="button-primary mt-4 w-full">
        {pending ? 'Finding address…' : 'Find their fee address →'}
      </button>
    </form>
    {error && <p id="lookup-error" role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
    {result && <div className="lookup-result mt-6 pt-5" aria-live="polite">
      <p className="text-xs font-extrabold uppercase tracking-widest">Confirm the recipient</p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="break-all font-display text-2xl">@{result.handle}</p>
        <a href={PLATFORMS[result.platform].profileUrl(result.handle)} target="_blank" rel="noopener noreferrer" className="text-sm font-bold underline underline-offset-4">Check {PLATFORMS[result.platform].label} profile ↗</a>
      </div>
      <p className="mt-2 text-sm text-ink/70">Check the spelling and profile. Looking up a handle does not verify its owner or their endorsement.</p>
      <label className="confirmation mt-4 flex cursor-pointer items-start gap-3 rounded-xl p-3 text-sm">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-ink" />
        This is the handle I want to receive the fees.
      </label>
      {confirmed && <div className="mt-5"><RecipientSetup address={result.address} /></div>}
      <Link href={explorePath(result.platform, result.handle)} className="mt-5 inline-block text-sm font-bold underline underline-offset-4">View @{result.handle}’s recipient page →</Link>
    </div>}
    {!result && <p className="mt-4 text-xs font-semibold text-ink/60">The recipient doesn’t need to join before you look them up.</p>}
  </div>;
}
