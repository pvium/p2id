'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useRef } from 'react';
import { HandleLookup } from './HandleLookup';
import { Icon } from './Icon';
import { RecipientSearch } from './RecipientSearch';

const OpenSetup = createContext<() => void>(() => {});
export function SetupButton({ children = 'Find a fee address', className = 'button-primary' }: { children?: React.ReactNode; className?: string }) {
  const open = useContext(OpenSetup);
  return <button type="button" onClick={open} className={className}>{children}</button>;
}

export function AppShell({ children, factory, claimUrl, docsUrl }: { children: React.ReactNode; factory: string | null; claimUrl?: string; docsUrl: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();
  return <OpenSetup.Provider value={() => dialog.current?.showModal()}>
    <a href="#main" className="skip-link">Skip to content</a>
    <aside className="sidebar" aria-label="Sidebar navigation">
      <Link href="/" className="brand-mark" aria-label="P2ID home">p<span>2</span></Link>
      <div className="sidebar-links">
        <Link href="/" className={`rail-link ${pathname === '/' ? 'active' : ''}`} aria-label="Explore tokens" title="Explore tokens"><Icon name="grid" /></Link>
        <SetupButton className="rail-link"><Icon name="search" /><span className="sr-only">Find a fee address</span></SetupButton>
        <Link href={claimUrl || '/#claim'} className="rail-link" aria-label="Claim fees" title="Claim fees"><Icon name="wallet" /></Link>
      </div>
      <a href={docsUrl} target="_blank" rel="noopener noreferrer" className="rail-link mt-auto" aria-label="Protocol documentation" title="Protocol documentation"><Icon name="book" /></a>
      <span className="rail-footer">P2ID</span>
    </aside>
    <div className="app-body">
      <header className="topbar">
        <Link href="/" className="mobile-brand" aria-label="P2ID home">p2id<span>●</span></Link>
        <a href="https://github.com/pvium/zkid/blob/main/P2ID.md" target="_blank" rel="noopener noreferrer" className="protocol-credit">Powered by <strong>P2ID protocol</strong> ↗</a>
        <RecipientSearch key={`${pathname}:${factory}`} factory={factory} />
        <div className="topbar-actions"><SetupButton /><Link href={claimUrl || '/#claim'} className="button-secondary" aria-label="Claim fees"><Icon name="wallet" /><span>Claim fees</span></Link></div>
      </header>
      {children}
    </div>
    <dialog ref={dialog} className="setup-dialog" aria-label="Find a recipient’s fee address" onClick={(event) => {
      if (event.target === event.currentTarget || (event.target instanceof Element && event.target.closest('a[href^="/"]'))) dialog.current?.close();
    }}>
      <div className="relative">
        <button className="dialog-close" type="button" onClick={() => dialog.current?.close()} aria-label="Close fee address lookup"><Icon name="close" /></button>
        <HandleLookup factory={factory} />
      </div>
    </dialog>
  </OpenSetup.Provider>;
}
