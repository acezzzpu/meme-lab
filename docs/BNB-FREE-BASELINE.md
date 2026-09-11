# BNB PAPER: free baseline and request budget

Set `BSC_FREE_BASELINE=1` in Render Environment. This selects PublicNode HTTP/WSS,
NodeReal public HTTP/WSS, official BNB HTTP and dRPC HTTP fallback; saved QuickNode credentials
are not used. It starts no signer and requires PAPER targets. No subscription,
private key, funded wallet, or transaction send is needed.

`copy_rpc_telemetry` and `copy/state.rpc_telemetry` expose wire requests by method,
provider, pipeline and transport, rolling requests/minute and hour, 429/quota
errors, timeouts, cache hit ratio and WebSocket notification counts/bytes. The
existing latency tab displays these counters. Provider-reported remaining quota
is null unless actually exposed. Local credit estimates are not billing totals.

## What consumed the old quota

The September 11 00:03:52 UTC database contained 36,077 processed blocks and 57,994
BLOCK job attempts (47,546 on completed jobs; 10,448 on queued jobs). Job attempts
include cache/backoff checks and are NOT exact HTTP request counts. The earlier
23:18 UTC provider snapshot recorded 38,504 global pending notifications. The
QuickNode dashboard reported 2,000,000 used credits and both transports returned
`daily request limit reached`. Complete pre-fix method counts were not recorded;
an exact allocation of the 2M credits cannot be reconstructed from those records.

QuickNode bills WebSocket responses, including unrelated pending transactions
discarded locally. See [QuickNode method breakdown](https://support.quicknode.com/articles/9223695305-understanding-my-method-call-breakdown-in-metrics-tab)
and [BNB method credits](https://www.quicknode.com/api-credits). Filtering after
delivery does not avoid these credits.

## Controls

* Unfiltered metered pending streams require explicit `BSC_PRIMARY_ALLOW_UNFILTERED_PENDING=1`
  (or SECONDARY equivalent). Full-payload public pending is filtered locally;
  hash-only feeds never fan out into unrelated transaction lookups.
* HTTP starts are paced per provider. Fast successful reads use one provider.
  Failure starts a fallback immediately; slow reads use a bounded hedge. Every
  endpoint is attempted at most once per call. Daily-quota failures open a circuit
  for at least one hour; transient failures use exponential backoff and jitter.
* Indexed job kind/readiness and block height lookups avoid full-table scans of
  retained jobs. On Render, the measured recovery lookup fell from 18.52 ms over
  37,937 jobs to 0.098 ms. A 40,000-job regression protects indexed access.
* Two current-block read workers keep up with BSC blocks while preserving atomic
  durable capture, deduplication and reorg fences. Current-window gaps are recovered
  in height order; old pre-session gaps are retained without automatic scanning.
* No history worker starts by default. To explicitly enable it requires
  `BSC_ENABLE_BACKFILL=1`, `BSC_ARCHIVE_HTTP` and `BSC_ARCHIVE_SEPARATE_QUOTA=1`.
  The archive must use an independent account/quota, not another URL on the live
  account. No fallback to live providers is permitted; archive starts are capped
  at 0.5 RPS. Configure `BSC_ARCHIVE_DAILY_CREDITS` when the quota is known; 80% of
  locally measured credit use pauses history. Shared use outside this engine is
  not observable through this local estimate.
* Token metadata and authenticated pool properties are cached and concurrent
  metadata reads coalesce. Current balances and reserves are never immutable-cache
  entries. Processed block hashes and transaction hashes persist in SQLite.
* No automatic 30/60-second follow-up quotes. Position mark quotes run at most once
  per minute. Target receipts and PAPER quotes have priority over maintenance.
* Capture audits use a nonce baseline read at session start and a nonce at the
  fully scanned end block. An inactive target reports `NO_TARGET_ACTIVITY`, not
  a fabricated 100% capture rate. Replay is excluded from live latency results.

## Indexed history investigation

[NodeReal nr_getTransactionByAddress](https://docs.nodereal.io/reference/nr_gettransactionbyaddress)
returns indexed outgoing normal transactions using `category:["external"]` and
`addressType:"from"`, with paging and at most 1,000 blocks per bounded interval.
It requires a MegaNode key. [dRPC wallet history](https://drpc.org/docs/data-api/transaction-api/gettransactionshistory)
requires a key and lists 1,837 CU per request. Neither private indexed capability
has been claimed as available on a public URL. The existing 50 cached transactions
are sufficient for regression; no bulk history download is necessary in this
iteration. The existing Etherscan import is optional and must not trigger raw
block scans when its key/plan is absent.

Official [BNB public endpoints](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/)
document 10,000 requests per five minutes and disable `eth_getLogs`; filtered
single-block transfer logs therefore require a supporting fallback. Public endpoints
have no availability guarantee. dRPC public rate limits observed during validation
must stay visible rather than being called a healthy backup.

NodeReal publishes a [public/shareable BSC key](https://docs.nodereal.io/reference/getting-started-with-your-api); it is not a private user credential. The preset limits its HTTP requests to 1/second and subscribes only to new heads. A Render probe received 144 heads in 65 seconds without an error. Its documented public HTTP limit is 2,000 CU/minute/IP; [WS accounting is bandwidth-based](https://docs.nodereal.io/docs/compute-units-cus) at 0.04 CU/byte. Telemetry retains notification bytes and estimated CU use; these estimates do not establish the provider's actual billing or an availability guarantee. dRPC public returned HTTP 429 from Render, so it remains a cooled-down HTTP fallback instead of the required secondary WebSocket.

## Evidence and acceptance

Run `node --test --test-concurrency=1 tests/*.test.mjs`. Real receipt regression
contains 50 consecutive hashes: 22 BUY, 12 PARTIAL_SELL, 2 SELL, 14 APPROVAL.
Two replay sales have earlier buys in the dataset; 12 have no earlier entry.
The virtual ledger must not fabricate starting inventory to make them sell.

`scripts/replay-copy-paper.mjs` uses cached real target evidence and current own
market quotes in an empty isolated `COPY_REPLAY_DIR`. It is historical replay.
`scripts/verify-copy-paper-live.mjs` uses an isolated `COPY_PROOF_DIR` for bounded
real-time observation without a signer. Neither counts alone nor unit-test quotes
certify live acceptance. PAPER may use indicative route quotes; unknown transfer
tax and unvalidated atomic paths remain explicit model limitations.
