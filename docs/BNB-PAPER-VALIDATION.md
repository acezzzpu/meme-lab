# BNB copy PAPER recovery — validation in progress

Target: `0x80a65fcaeabbb0aa4c9a85087f9e0f7ba26f293f`, BSC mainnet 56. No real-money acceptance is claimed or enabled by this change. The required new observed target BUY and subsequent SELL have not yet been demonstrated.

## Changed behavior

Every outgoing transaction found in a canonical full block is durably recorded before receipt processing. Mempool observations create a provisional intent keyed by chain/hash/target. The custom calldata layout used by all 36 trades in the captured sample is decoded provisionally; current quotes can begin before confirmation. Receipt net token movements determine the final event independently of router identity. Approvals, failed calls, transfers and unresolved transactions remain recorded.

HTTP reads race two providers. Both WebSockets remain connected independently; their HTTP health is also checked. Live block scanning, target decoding and PAPER execution have independent loops. Historical recovery runs in a separate child process with a separate RPC client and an optional archive endpoint. Source retries are retained rather than abandoned after five failures.

PAPER uses its own virtual cash/inventory and current route quotes without a funded wallet, approvals or LIVE safety vetoes. It preserves raw integer quantities, fees, proportional partial exits, repeated buys, reentry and realized PnL. A target sale of at least 98% closes the remaining PAPER position. Unknown taxes and indicative multi-pool routes are explicitly labelled; their output is a model, not a confirmed fill. Atomic execution and intermediate-token tax compatibility have not passed SHADOW validation.

## Evidence obtained on 2026-09-10

- Last 50 confirmed outgoing transactions: 50 consecutive nonces 46580–46629, no missing nonce. Fixed reference head 121144751. This is a historical capture audit, not proof of live capture rate.
- Receipt decoder: 22 BUY, 12 PARTIAL_SELL, 2 SELL, 14 APPROVAL. All retained. Real fixtures and captured RPC responses are in `tests/fixtures/bnb-target-20260910`.
- Independent archived native audit: 10 BUY and 10 SELL directions match. The 10 sales pay a 1% router fee; a WBNB withdrawal is gross output, not exact final BNB proceeds. The fast decoder labels that uncertainty. Optional tracing can enrich the event only in the separate archive worker.
- Historical replay using real current own market quotes: 22 PAPER buys and 2 proportional PAPER sells. Twelve other sales have no copied position because their target entries precede the captured window. No opening inventory was fabricated. This replay does not certify new live copying or full-exit acceptance.
- A 15-minute local observer remained connected and scanned blocks but saw no outgoing target trade. Three inbound transfers did not trigger buys. A second 5-minute run received 665 heads and 58,078 pending messages with zero reconnections, again without an outgoing target trade. Live BUY/SELL detection and reaction quantiles are therefore unavailable.
- Public HTTP diagnostic measurements from this Windows machine: BNB public warm block-number queries approximately 162–167 ms; PublicNode 191–274 ms; QuickNode documentation demo 196–206 ms; dRPC public 212–218 ms before a 429 response. Small samples, not Render measurements or a paid-provider ranking.

## Prepared server configuration

Render validation exposed HTTP 429 responses during block recovery even though isolated HTTP and full-block reads were fast. A concurrency limit alone permits request bursts when responses are fast. Environment providers now pace HTTP starts (8/s by default) and the separate historical process is capped at 2/s per provider. Urgent queued requests get the next available slot. `BSC_PRIMARY_RPS` and the equivalent role variables may be raised only within the account's total allowance, including history and other consumers. This does not replace an independent secondary provider or prove live trade acceptance.

Set these on Render → meme-lab-engine → Environment, or in the gitignored local `.env.copy-paper` for local verification:

| Variable | Required capability |
|---|---|
| `BSC_PRIMARY_HTTP`, `BSC_PRIMARY_WS` | Private BSC mainnet HTTP/WSS, newHeads and pending stream; prefer full pending objects |
| `BSC_SECONDARY_HTTP`, `BSC_SECONDARY_WS` | Independent provider with the same capabilities |
| `BSC_ARCHIVE_HTTP` | Separate archive access for historical state and optional native trace enrichment |
| `BSC_BENCHMARK_HTTP`, `BSC_BENCHMARK_WS` | Optional third provider to compare |
| `ZEROX_API_KEY` | 0x Swap API v2 `/price` for PAPER; `/quote` remains separate |

QuickNode Build is a starting candidate with 50 RPS, advertised at USD 49 monthly (trial available). NodeReal is an independent candidate; its private pending-stream capability and performance must be measured with an actual endpoint. dRPC public throttled in this diagnostic; a paid endpoint remains unmeasured. These are candidates, not a verified fastest-provider recommendation. No subscription was purchased.

Official documentation checked: [QuickNode BSC subscriptions](https://www.quicknode.com/docs/bnb-smart-chain/eth_subscribe), [QuickNode pricing](https://www.quicknode.com/pricing), [dRPC BSC subscriptions](https://drpc.org/docs/bsc-api/subscriptions), [NodeReal BSC pending filter](https://docs.nodereal.io/reference/eth-newpendingtransactionfilter-bnb-chain), [NodeReal archive](https://docs.nodereal.io/docs/archive-node), [0x PAPER price](https://docs.0x.org/api-reference/evm-ap-is/swap/allowanceholder-getprice), [0x tax support](https://docs.0x.org/evm/0x-swap-api/additional-topics/buy-sell-tax-support), [Uniswap BSC deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-bnb-deployments).

## Verification commands

`node --test --test-concurrency=1 tests/*.test.mjs` — 209 tests passed, including crash recovery.

`node node_modules/vite/bin/vite.js build --config vite.standalone.ts`

With a new isolated `COPY_REPLAY_DIR`, run `node --env-file-if-exists=.env.copy-paper scripts/replay-copy-paper.mjs`. Historical source evidence is fixed; quotes are fetched at replay time. Never point it at the production database.

With a new isolated `COPY_PROOF_DIR`, run `node --env-file-if-exists=.env.copy-paper scripts/verify-copy-paper-live.mjs`. It uses the real watcher and virtual PAPER ledger. It never fabricates target transactions, launches a signer or certifies success from fill counts. The default observation duration is 15 minutes.

Authenticated `POST /api/lab/copy/self-test` queues actual runtime checks. Critical missing evidence produces `BLOCKED`. `POST /api/lab/copy/capture-audit` with `{target,fromBlock,toBlock}` compares recorded outgoing transaction nonces against independent chain account counts. Zero target activity is reported as `NO_TARGET_ACTIVITY`, never a 100% pass.

## Still required before acceptance

Private endpoint and 0x keys; provider comparison from Render; measured failover between two independent WebSockets; fresh target BUY and subsequent SELL with matching own PAPER positions, own quotes, fee/PnL records and local monotonic timings. Mempool visibility cannot be guaranteed. Pending interpretations remain provisional until the canonical receipt. Complex multi-asset transactions and unresolved native attribution remain explicit rather than guessed. The front-end comparison screen and phase 2 stay deferred until the core live proof passes.
