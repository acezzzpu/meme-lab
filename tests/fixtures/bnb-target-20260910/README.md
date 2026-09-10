# Real BSC historical validation sample

50 consecutive outgoing transactions from the requested target, nonces 46580–46629, ending at block 121144751 as observed on 2026-09-10. Includes successful approvals, buys and sales. Captured using an archive RPC, independently checked by account nonce counts. Native amounts for 10 buys and 10 sells were cross-checked with archived call trees; these traces are not required by the live decoder.

sample.json.gz.b64 is base64-encoded gzip containing the public transaction/receipt/header evidence and regression expectations. Original JSON SHA-256: 10797ee404dce3ea3432bb55b4740aabd68d3257cda980fa583eb2a2d036ed22. Compression keeps repeated receipt data manageable. rpc.json contains real archived balance/metadata responses. native-audit.json records the separate 20-transaction native audit, including the 1% router fee in all 10 checked sells.

These are historical fixtures. The deterministic accounting test explicitly uses synthetic quotes and is not live acceptance. scripts/replay-copy-paper.mjs instead fetches real current own quotes into a separate database. Neither replay proves a new live BUY → SELL.
