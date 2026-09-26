'use client';

import { useState } from 'react';

export function CopyButton({ value, className = '', label = 'Copy' }: { value: string; className?: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return <span className="inline-flex flex-col items-start gap-1">
    <button type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(value); setState('copied'); }
      catch { setState('failed'); }
    }} className={`button-primary ${className}`}>
      {state === 'copied' ? 'Copied ✓' : label}
    </button>
    <span role="status" className="text-xs font-semibold">{state === 'failed' ? 'Select and copy the address above.' : ''}</span>
  </span>;
}
