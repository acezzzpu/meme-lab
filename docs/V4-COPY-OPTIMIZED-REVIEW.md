# V4 development review — not approved for deployment

2026-09-14. Branch: `development/copy-v4-optimized`.

**Status: development implementation with incomplete end-to-end validation. Do not deploy or fund.** No Render operation, production configuration change, signing or broadcast was performed in this iteration. The proposed `baseline-v4-copy-optimized` has not started; the +0.25 BNB virtual addition has not been applied. Copy size and production real-money settings were not changed.

The GitHub branch starts at production commit `66f2e5ddab846f366287216f4f043d9f76cfe75b`. The local preserved checkout at `a26e305` has the same source contents: four Git blob differences were verified as line-ending/trailing-newline differences only. Baseline evidence was copied separately, with SHA-256 hashes, without editing originals: 21 files, 12,948,116 bytes. The workspace `outputs/v4-development/preservation-manifest.json` lists originals and preservation copies. No production SQLite database was opened or edited.

## Routing and protected execution

The five original audited transaction receipts are checked into `tests/fixtures/v4`. Tests verify successful canonical receipts, matching transaction/block hashes and protocol detection without additional BUY decoding RPC calls.

| Fixture | Route | Previous audited outcome | New direct protected BUY replay | Quote output / simulated token credit, raw |
|---|---|---|---|---|
| R1 CTRL | Four.meme TokenManager2 | NO_EXECUTABLE_ROUTE | PASS | 48420733332211000000000 |
| R2 CTRL | Four.meme TokenManager2 | NO_EXECUTABLE_ROUTE | PASS | 79858668772132000000000 |
| R3 黑神话：巨兽 | Pancake V2 → V3 → ERC20 quote → Flap | NO_EXECUTABLE_ROUTE | PASS | 230935936401396934033846 |
| R4 🤏 | Four.meme TokenManager2 | NO_EXECUTABLE_ROUTE | PASS | 146930959297730000000000 |
| R5 ASTI | Uniswap v4 | NO_EXECUTABLE_ROUTE | PASS | 19028370064234254729497 |

These are **five independently quoted, unsigned simulated purchases**, each spending 0.002 BNB with a 300-bps validation slippage setting. That setting is confined to the replay request; production configuration is unchanged. Every final minimum is derived from the quote and greater than 1. The state is pinned to the end of the original target block, not the precise intra-block state immediately after the target transaction. Simulation uses a declared hypothetical native balance and current-time override for deadlines. It does not establish a live fill or copying profitability.

Four.meme verifies helper-returned manager/version, native quote currency and unmigrated state. It quotes fees through the helper and builds protected `buyTokenAMAP` / `sellToken`. The observed `GW` sell revert required raw token amounts divisible by 1e9. Partial sells now floor to that protocol quantum and retain the unspent dust and corresponding cost basis. The PAPER regression verifies the actual fill path and duplicate-ledger protection.

Uniswap v4 verifies the PoolManager log emitter, reconstructs the PoolKey from observed route calldata, checks its keccak PoolId, quotes the deployed quoter and builds Universal Router commands with a protected output. The implemented executable coverage is native-BNB/token pools with zero hooks, including R5. Unresolved PoolKeys, other currency pairs and nonzero hooks fail explicitly; this is not universal support for all v4 pools. SELL construction includes explicit token/Permit2 approvals, without signing.

The mixed route verifies every V2/V3 pool against its factory, route continuity and Flap quote currency. It builds one atomic transaction through the target-observed router. A protected simulation measures net recipient credit before accepting the quote: the R3 gross-hop calculation overstated credit by approximately 1%, so the adapter uses verified net credit. The custom router's full implementation and general behavior are not independently validated; it remains blocked for LIVE. Reverse mixed SELL is not implemented.

All three new adapters remain outside the LIVE allowlist. Existing Pancake safety validation remains in place.

## SELL and SHADOW validation

The retained archive SELL run contains **6/8 PASS**: R1, R2 and R4 each pass partial 50% and full 100% exits. Token debits equal the built amount; full exits leave zero inventory. R5's two attempts in that retained run were blocked by NodeReal public quota (`-32005: maximum API usage limit of public`). Earlier exploratory R5 simulations succeeded, but they are not substituted for a complete retained passing run.

A second public RPC returned `missing trie node` on the historical calls. These are infrastructure failures, not evidence of an executable-route revert. Raw failures are retained separately. The full 8/8 protected SELL batch must be repeated on an archive RPC before acceptance.

Advanced SHADOW reuses the exact PAPER quote when it is still valid, then constructs and simulates independently. This avoids duplicating route discovery, particularly for the mixed route. Expired quotes are refreshed. BUY additionally requests `eth_estimateGas`; seeded SELL reports gas consumed by its sequential simulation, not a standalone gas estimate on invented token storage. Simulation checks net proceeds and exact token debits. It never writes token/allowance storage overrides or reaches a signer. New tests reject below-minimum credits and verify unchanged PAPER minimums, gas evidence and read-only RPC boundaries. The final integrated SHADOW path still needs an archive-backed end-to-end replay; direct adapter tests are not a live SHADOW success-rate claim.

## Latency: measured results and limits

The pre-existing engine already had immutable pool metadata caching, RPC connection reuse, local Pancake V2 reserve calculations and parallel candidate selection. Those mechanisms were retained. New route hints retain observed PoolKeys/descriptors; mutable reserves, curve state and token prices are not cached as immutable data.

The remaining serial preferred-Flap wait was changed to a bounded 250-ms head start followed by concurrent fallback. Per-route quote budgets are bounded, and losing attempts receive cancellation. Existing first-quote/selection/PAPER instrumentation is preserved; advanced SHADOW exposes build/simulation timings.

| Measurement | Before | After | Interpretation |
|---|---:|---:|---|
| Controlled preferred-route failure, quote selection P50 | 433.53 ms | 294.03 ms | 10 identical synthetic samples per version; 32.2% faster, same minimum/output |
| Five new direct historical BUY quotes | No executable quote | P50 376.73 ms | Coverage test, not a comparable latency improvement |
| Four.meme direct quote | Unsupported | 951.54 / 376.73 / 368.25 ms | Three historical cases, public RPC |
| Atomic mixed quote plus net simulation | Unsupported | 1363.26 ms | One case; sequential dependent hops and simulation |
| v4 direct quote | Unsupported | 190.36 ms | One case |
| Full route selector, R1 / R2 | Rejected | 916.85 / 873.49 ms | Remaining three cases hit public-provider quota |
| Live PAPER reaction P50 | Existing production evidence | Not measured | No deployment or live new-version sample |
| Live SHADOW reaction P50 | Existing production evidence | Not measured | No deployment or live new-version sample |

The full selector issued 20 RPC calls for each of R1/R2 versus the much smaller direct-adapter path. Competing discovery remains a cost under public latency/quotas. Therefore **sub-second live PAPER reaction is not demonstrated**, and the old ~2092-ms cohort cannot honestly be compared with these five different historical cases. DNS/TLS versus remote RPC processing was not separately established for this replay. No paid-infrastructure recommendation follows from these measurements alone.

## Dashboard delivery

The standalone SSE endpoint now sends a current-state projection every two seconds instead of repeatedly serializing full state/history. One read-only SQLite worker produces a shared snapshot for all clients; clients multiply transmitted bytes but not snapshot queries. The reader omits raw transactions, quote histories and large RPC diagnostic bodies. It retains recent target activity, copy actions, position quantities/costs, provider health, block progress and bounded latency summaries. The summary explicitly labels its last-300-profile window; canonical stored metrics/evidence are unchanged.

Authenticated historical reads are available at `/api/lab/history/events?source=events|actions|targets|profiles&limit=25&before=...`. Pages are capped at 100 metadata rows. Individual data uses `id` plus `offset` and 32-KiB UTF-8 byte chunks encoded as hex, preserving original bytes. History reads run in the same isolated reader with bounded pending requests. Existing explicit exports remain on demand.

The regression inserts a 74,000,000-character diagnostic, verifies a 4,450-byte current snapshot (below 64 KiB), preserves the full original row and asserts no ledger or LIVE-setting mutation. This is a synthetic fixture bound, not a measured production average. At 30 messages/minute, 64 KiB would imply about 112.5 MiB/hour/client before framing/compression. Actual populated production payload size, CPU contention, reconnect behavior and browser detail navigation still require staging/load validation. The broader initial state/bootstrap now also reads and serializes in the isolated worker, sharing concurrent requests. Explicit legacy diagnostic exports still use their existing on-demand path. Browser detail navigation and populated-client load remain acceptance checks; the synthetic result does not prove zero CPU contention.

## Regression result and deployment gate

Baseline suite: **310/310 PASS**. Current suite: **324/324 PASS**, including canonical receipts, slippage fences, v4 approvals, bounded hedge cancellation, Four PAPER dust/accounting, protected SHADOW, large-history isolation, existing SSE lifecycle, restart/reorg recovery and execution tests. Standalone Vite build passes; the existing >500-KiB bundle warning remains.

Protected BUY gas-fee estimates are 0.0000225 BNB for Four, 0.0000425 BNB for mixed and 0.0000096619 BNB for R5 v4. Four helper protocol fees are included in quoted proceeds; the mixed net quote includes its observed approximately 1% route deduction. These are historical estimates/simulated credits, not fees paid by our wallet. Existing quote/fee/ledger tests pass, but a complete old/new historical PAPER→SHADOW→position reconciliation matrix is still outstanding.

**Release gate remains closed.** Required before deployment approval: a retained all-fixture archive selector/BUY/SELL/SHADOW run; integrated before/after fee and ledger comparison; browser detail navigation and populated-client load tests; a defensible critical-path latency breakdown. Do not fund or start v4 while these are outstanding. No modification to baseline-v1, baseline-v2-funded or baseline-v3-stable is required to finish them.

Replays require Node >=24.19 and a read-only archive RPC supporting `eth_simulateV1`:

```powershell
$env:V4_FIXTURE_RPC = '<archive RPC URL kept locally>'
$env:V4_BASELINE_DIR = '<preserved v3 checkout>'
$env:V4_OUTPUT_DIR = '<new evidence directory>'
node --test tests/*.test.mjs
node scripts/v4-protected-replay.mjs
$env:V4_BUY_EVIDENCE = '<new protected-replay JSON path>'
node scripts/v4-sell-replay.mjs
node scripts/v4-compare-routes.mjs
node scripts/v4-latency-benchmark.mjs
```

New replay files use unique names with exclusive creation; they do not overwrite prior runs. The fixture capture script likewise refuses to replace existing fixtures.

Primary contract references: [Four.meme maintained integration scripts](https://github.com/four-meme-community/four-meme-ai), [Uniswap v4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments), [Uniswap v4 quoter interface](https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Quoter.sol). The deployed Universal Router ABI was checked against the actual fixture simulation rather than assuming the latest source ABI matches that older deployment.
