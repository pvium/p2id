import type { SVGProps } from 'react';

export type IconName = 'grid' | 'search' | 'wallet' | 'arrow' | 'close' | 'book' | 'link' | 'spark' | 'chevron';
const paths: Record<IconName, React.ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  wallet: <><path d="M20 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-3" /><path d="M3 7h17v10h-7V11h7" /><path d="M16 14h.01" /></>,
  arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  book: <><path d="M12 5v15M3 4c4-1 7 0 9 2 2-2 5-3 9-2v15c-4-1-7 0-9 2-2-2-5-3-9-2z" /></>,
  link: <><path d="m9 15 6-6m-8 4-2 2a4 4 0 0 0 6 6l3-3m-4-12 3-3a4 4 0 0 1 6 6l-2 2" /></>,
  spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" /></>,
  chevron: <path d="m9 5 7 7-7 7" />,
};
export function Icon({ name, className = 'h-5 w-5', ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} {...props}>{paths[name]}</svg>;
}
