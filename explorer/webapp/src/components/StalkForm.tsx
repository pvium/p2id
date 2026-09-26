'use client';

import { useState } from 'react';
import type { Platform } from '@/lib/p2id/constants';
import { contactSchema } from '@/lib/stalk';

/** "Ping me when @handle gets paid". The explorer API decides eligibility and sends notifications. */
export function StalkForm({ platform, handle }: { platform: Platform; handle: string }) {
  const [contact, setContact] = useState('');
  const [state, setState] = useState<{ kind: 'idle' | 'sending' | 'ok' | 'error'; message?: string }>({ kind: 'idle' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const c = contactSchema.safeParse(contact);
    if (!c.success) {
      setState({ kind: 'error', message: c.error.issues[0]?.message });
      return;
    }
    setState({ kind: 'sending' });
    const res = await fetch('/api/stalk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform, handle, contact: c.data }),
    }).catch(() => null);
    const data = (await res?.json().catch(() => ({}))) as { message?: string; error?: string } | undefined;
    if (res?.ok) setState({ kind: 'ok', message: data?.message });
    else setState({ kind: 'error', message: data?.error ?? 'Something went wrong. Try again.' });
  }

  if (state.kind === 'ok') {
    return <p className="sticker-sm rounded-xl bg-slime px-4 py-3 font-bold">👀 {state.message}</p>;
  }

  return (
    <form onSubmit={submit} className="sticker-sm rounded-2xl bg-bubblegum/90 p-4">
      <p className="font-display text-lg tracking-wide">STALK @{handle.toUpperCase()} 🕵️</p>
      <p className="mt-1 text-sm font-semibold">We&apos;ll ping you every time they get paid. Stalking may require holding tokens.</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor={`stalk-${handle}`}>
          Email or Telegram username
        </label>
        <input
          id={`stalk-${handle}`}
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          placeholder="you@mail.com or @telegram"
          autoComplete="email"
          className="sticker-sm flex-1 rounded-xl bg-white px-3 py-2 font-semibold outline-none placeholder:text-ink/35"
        />
        <button
          type="submit"
          disabled={state.kind === 'sending'}
          className="sticker-sm press rounded-xl bg-ink px-4 py-2 font-display tracking-wide text-paper disabled:opacity-60"
        >
          {state.kind === 'sending' ? '…' : 'PING ME'}
        </button>
      </div>
      {state.kind === 'error' && <p className="mt-2 text-sm font-bold">🙅 {state.message}</p>}
    </form>
  );
}
