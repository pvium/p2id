# P2ID web app

The first user journey is **choose a platform and handle → confirm the recipient → derive and copy
its fee address → view the recipient page**. The homepage pairs tokens with the people their
fees are for. X, Farcaster and Telegram are available in the setup form and recipient pages.
Protocol documentation stays in the footer.

The dark explorer puts token discovery first: a compact intro, featured-token strip,
artwork cards with recipient badges, search, platform filters and sorting by name or fee share.
The persistent **Find a fee address** action opens the three-platform lookup in a native dialog
(keyboard focus, Escape and backdrop dismissal). Header search suggests X, Farcaster and Telegram
fee addresses for a handle, with platform icons and SDK-derived addresses. Users explicitly select
a platform; profile links match only their own platform. Arrow keys, Enter and Escape are supported.
The token-list search remains separate and accepts a `q` URL parameter on the homepage.
Preview artwork is original inline SVG in `TokenArt.tsx`; no external image service is needed.

The homepage also includes a two-column discovery section: paginated top-token tiles and
recipient profile cards with covers, avatars, token counts and deposit totals. Each panel has
its own recipient-platform filter. `lib/home-highlights.ts` supplies labelled preview rankings
and market caps when the indexer is unconfigured; those values are never attached to live tokens.

```sh
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
yarn install
cp .env.example .env.local
yarn dev
```

Run `yarn build`, `yarn typecheck` and `yarn lint` for validation.

## Launch readiness

- Addresses use the SDK's current scheme and selected environment. No factory means no address
  is displayed. Sandbox uses BNB testnet links and a test-funds notice.
- `NEXT_PUBLIC_PVIUM_URL` enables claim links to the existing claim application. Without it,
  pages state that claiming opens at launch. This frontend does not generate proofs itself.
- There is no embedded token launcher, token submission endpoint or on-chain routing verifier
  in this app. Guided launch setup remains unavailable until a venue-to-vault-to-claim flow
  has been tested. Do not advertise generic four.meme compatibility without that verification.
- The vault currently handles ERC-20 tokens, not native BNB. The address panel states this.
- Without an indexer, six sample token cards show the finished homepage layout, and recipient
  pages show three sample cards. These are labelled preview data, with no invented contract
  addresses or transaction links. Configured indexers retain real empty and error states.
- The previous ticker and notification modules remain unused by the public pages. Token-gated
  notifications remain outside the initial journey.

## Optional token indexer

`P2ID_API_URL` is a server-side base URL. The app requests `GET /tokens`, with `platform` and
`handle` query parameters on recipient pages. Results are cached for 60 seconds; requests
have a five-second timeout. The indexer must verify fee routing on chain before returning
`routingVerified: true`. This flag is trusted server data, not verification performed by the UI.

The response is `{ "items": [...] }`, with at most 50 entries:

```json
{
  "address": "0x...token address...",
  "name": "Example",
  "symbol": "EXAMPLE",
  "chainId": 56,
  "recipient": {
    "platform": "x",
    "handle": "someone",
    "address": "0x...derived P2ID address..."
  },
  "routingVerified": true,
  "allocationPercent": 100,
  "deposits": [{ "amount": "0.42", "symbol": "WBNB" }],
  "latestDepositTx": "0x...transaction hash..."
}
```

Use full hexadecimal addresses/hashes and chain ID 97 in sandbox. `deposits` contains cumulative
amounts actually delivered by this token's fee route, grouped by asset; it is not the token's
market value or the recipient's current balance. `allocationPercent` describes the share of
the configured fee allocation, not a percentage of trading volume. `latestDepositTx` is optional.
The app validates entries, re-derives recipient addresses, rejects wrong-chain entries, filters
recipient pages and deduplicates token addresses. Token and receipt links point to BscScan.

SDK changes require rebuilding `sdks/node/p2id-core` (`yarn workspace @pvium/p2id-core build` from `sdks/node`) and refreshing the local install here (`yarn add @pvium/p2id-core@file:../../sdks/node/p2id-core`).
