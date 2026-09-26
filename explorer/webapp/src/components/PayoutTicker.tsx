import { PLATFORMS } from '@/lib/p2id/constants';
import { shortAddress, type RecentPayouts } from '@/lib/payouts';
import { PlatformIcon } from './PlatformIcon';

const chipColor = { x: 'bg-sky', farcaster: 'bg-bubblegum', telegram: 'bg-slime' } as const;
const prefix = { x: 'x', farcaster: 'fc', telegram: 't' } as const;

/** Scrolling strip of handles getting paid. Example data is always labelled as such. */
export function PayoutTicker({ data }: { data: RecentPayouts }) {
  const items = [...data.items, ...data.items];
  return (
    <section aria-label={data.examples ? 'Example payouts' : 'Recent payouts'} className="relative -rotate-1 border-y-[3px] border-ink bg-ink py-3">
      {data.examples ? (
        <span className="sticker-sm absolute -top-4 left-4 z-10 rotate-[-4deg] rounded-full bg-paper px-3 py-0.5 font-display text-sm tracking-wide text-ink">
          EXAMPLES · LIVE AT LAUNCH
        </span>
      ) : (
        <span className="sticker-sm absolute -top-4 left-4 z-10 flex items-center gap-1.5 rotate-[-4deg] rounded-full bg-slime px-3 py-0.5 font-display text-sm tracking-wide text-ink">
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /> LIVE
        </span>
      )}
      <div className="overflow-hidden">
        <ul className="marquee flex w-max gap-4 whitespace-nowrap">
          {items.map((p, i) => (
            <li key={`${p.platform}-${p.handle}-${i}`} className="flex items-center gap-2 text-paper" aria-hidden={i >= data.items.length}>
              <span className={`flex items-center gap-1.5 rounded-full ${chipColor[p.platform]} px-2.5 py-1 text-sm font-extrabold text-ink`}>
                <PlatformIcon platform={p.platform} className="h-3.5 w-3.5" />
                {prefix[p.platform]}:@{p.handle}
              </span>
              <span className="font-mono text-sm text-paper/70" title={`${PLATFORMS[p.platform].label} P2ID`}>
                {shortAddress(p.address)}
              </span>
              <span className="font-display text-xl tracking-wide text-bnb">
                +{p.amount} {p.symbol}
              </span>
              <span aria-hidden className="pl-2 text-bubblegum">✦</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
