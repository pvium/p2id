import { CopyButton } from '@/components/CopyButton';
import { CHAIN } from '@/lib/p2id/constants';
import { env } from '@/lib/env';

export function RecipientSetup({ address }: { address: string | null }) {
  if (!address) return <div className="setup-note rounded-xl p-4">
    <p className="font-bold">Fee addresses open at launch.</p>
    <p className="mt-2 text-sm">You can share this recipient page now. Their address will appear here when setup is ready.</p>
  </div>;
  return <div className="space-y-4">
    {(env.NEXT_PUBLIC_P2ID_ENV === 'sandbox' || env.NEXT_PUBLIC_P2ID_FACTORY_OVERRIDE) && <p className="test-notice rounded-lg p-3 text-xs">Test configuration · do not send real funds.</p>}
    <div className="address-panel">
      <p className="text-xs font-extrabold uppercase tracking-widest">Their P2ID fee address · {CHAIN.name}</p>
      <code className="mt-3 block break-all rounded-lg p-3 font-mono text-xs">{address}</code>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <CopyButton value={address} label="Copy fee address" />
        <a href={CHAIN.addressUrl(address)} target="_blank" rel="noopener noreferrer" className="text-sm font-bold underline underline-offset-4">View on {CHAIN.explorerName} ↗</a>
      </div>
    </div>
    <div>
      <h3 className="font-bold">Next: set up fees on four.meme</h3>
      <p className="mt-2 text-sm">We’re integrating with four.meme so you can use this address as your token’s fee recipient. Guided setup will explain the supported token settings and fee allocation.</p>
      <p className="setup-note mt-3 rounded-lg p-3 text-xs">The four.meme integration is in progress. This vault supports ERC-20 tokens; do not send native BNB to it.</p>
    </div>
  </div>;
}
