# BNB latency and SHADOW evidence

Production checkpoint: `checkpoint/bnb-paper-working-2026-09-11-d939403`, commit `d9394030bbcab5221e08cb5924c03bb9b5eba048`. Never move or delete this checkpoint. Retain the original PAPER engine and reverse any optimization that regresses capture, fills, position accounting, failover or materially increases RPC traffic.

## Measurements

`copy_latency_profiles` stores one durable profile per target trade, independent of browser sessions and worker restarts. It records monotonic local durations, wall timestamps for audit, provisional and canonical signals, PAPER results and a SHADOW comparison. Historical replay is excluded from live counts. Tail quantiles are withheld below 20 samples for P95 and 100 for P99; P50 requires two. Overlapping parallel stages are not added together as if sequential. Pending advantage is measured only when the same worker actually observed the pending transaction before its local observation of the containing head. Actual network propagation remains unknown.

The additive profiling deployment is `33268b7`. Render measurements showed PublicNode returning receipt-specific HTTP 403 denials, while BNB official returned 8/8 receipt reads successfully (wire P50 11.69 ms). The subsequent optimization prefers BNB official for receipts only and suppresses explicit archive-token receipt denials for 60 seconds. Block capture and normal fallback remain unchanged.

## SHADOW comparison

In the existing free BNB PAPER runtime, each new PAPER fill starts a read-only SHADOW comparison using the same amount, token, route quote and slippage. Set `BSC_SHADOW_COMPARE=0` to disable only this diagnostic. No signer, private key, approval transaction or swap transaction is sent. PAPER decisions and its ledger never depend on SHADOW success.

Builders cover Flap, Pancake V2, Pancake SmartRouter V2/V3, and homogeneous Uniswap V3 quoted paths. Unsupported mixed cross-protocol indicative routes explicitly fail construction. Flap has no onchain deadline parameter: the evidence reports null plus a local expiry, rather than inventing one.

The RPC simulation uses `eth_simulateV1` with a declared ephemeral 10 BNB native balance override for the hypothetical sender, plus `eth_estimateGas`. Token balance reads bracket the swap. SELL simulations include an unsigned approval in the simulated sequence; no token balance or allowance storage slot is invented. PAPER inventory is virtual and does not exist on chain, so a SELL can fail for missing simulation inventory. Such a failure is not proof that the token is unsellable. EVM call success alone does not pass output validation: received tokens or traced native proceeds must satisfy the exact quoted minimum.

The shared SHADOW diagnostic budget is at most 12 read requests per rolling minute, only through already chain-verified providers, with at most two providers per logical read and 2-second request limits. An exhausted budget is recorded, not bypassed. Historical backfill remains paused. SHADOW expected PnL is unknown unless complete comparable inventory and proceeds exist; a quote or a successful BUY alone does not establish it.

## Validation and evidence

235 baseline tests passed. Stage profiling: 239. Receipt preference and isolated SHADOW regression coverage: 247, including additional buys, exact proportional partial exits, full close, reentry, 429 failover, durable stage merging and simulation output validation. Render observations and the bounded 60-request provider benchmark are stored separately from local tests; synthetic tests and old receipt rereads never count toward the 50 new live events.

Official interfaces checked for this iteration:

- https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth
- https://geth.ethereum.org/docs/interacting-with-geth/rpc/objects
- https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/trade-tokens
- https://developers.uniswap.org/docs/protocols/v3/deployments/v3-bnb-deployments
- https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/interfaces/IV3SwapRouter.sol

