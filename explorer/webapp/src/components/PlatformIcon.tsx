import type { Platform } from '@/lib/p2id/constants';

/** Monochrome platform marks, sized by the parent's font size. */
export function PlatformIcon({ platform, className = 'h-4 w-4' }: { platform: Platform; className?: string }) {
  switch (platform) {
    case 'x':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      );
    case 'farcaster':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
          <path d="M5 3h14v2h1.5l.5 2h-1v12.5h.5v1H15v-1h.5V12a3.5 3.5 0 0 0-7 0v7.5H9v1H3.5v-1H4V7H3l.5-2H5z" />
        </svg>
      );
    case 'telegram':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
          <path d="M21.94 4.6 18.9 19.02c-.23 1.01-.83 1.26-1.68.78l-4.64-3.42-2.24 2.16c-.25.25-.46.46-.94.46l.33-4.75 8.64-7.8c.38-.33-.08-.52-.58-.19L7.1 12.98 2.5 11.54c-1-.31-1.02-1 .21-1.48L20.66 3.1c.83-.31 1.56.19 1.28 1.5z" />
        </svg>
      );
  }
}
