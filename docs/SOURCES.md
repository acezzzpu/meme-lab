# Fuentes primarias verificadas · 2026-09-09/10

- [Solana RPC](https://solana.com/docs/rpc): lectura, simulación, envío y confirmación.
- [Genesis hashes oficiales Anza](https://docs.anza.xyz/clusters/available/): comparación completa de mainnet/devnet.
- [Jupiter Swap v2](https://developers.jup.ag/docs/swap), [build](https://developers.jup.ag/docs/swap/build), [rate limits](https://developers.jup.ag/docs/portal/rate-limits), [responses](https://developers.jup.ag/docs/portal/responses): rutas, instrucciones, clave opcional con límites y fallos.
- [DexScreener API](https://docs.dexscreener.com/api/reference): token profiles y métricas de pares; no exhaustividad de pools.
- [Robinhood Chain connections](https://docs.robinhood.com/chain/connecting/): mainnet 4663, testnet 46630, ETH, RPC público/proveedor.
- [Robinhood contracts](https://docs.robinhood.com/chain/contracts/): WETH y activos documentados.
- [Uniswap V2 deployments](https://developers.uniswap.org/docs/protocols/v2/deployments): factory `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` y Router02 `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba`.
- [Uniswap supported chains](https://developers.uniswap.org/docs/trading/swapping-api/supported-chains): API también soporta mainnet Robinhood; no se integró API universal en esta versión, se usa V2 directo.
- [Uniswap deployment registry](https://developers.uniswap.org/deployments.json): referencias de contratos. La investigación detectó direcciones diferentes de UniversalRouter entre versiones; esta implementación evita ese router y usa V2 documentado.

La documentación de un despliegue no prueba liquidez ni ejecución. Los JSON de `evidence/` contienen las consultas realizadas desde este entorno y sus errores. Robinhood no se marcó conectada si su RPC agotó el timeout.

## Motor persistente · 10/09/2026

- [Solana logsSubscribe](https://solana.com/docs/rpc/websocket/logssubscribe), [slotSubscribe](https://solana.com/docs/rpc/websocket/slotsubscribe) y [getTransaction](https://solana.com/docs/rpc/http/gettransaction): suscripción, checkpoint y verificación de instrucciones.
- [PumpSwap IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json): programa y discriminador create_pool, índices de cuentas.
- [Raydium program addresses](https://docs.raydium.io/reference/program-addresses) y [CPMM initialize](https://github.com/raydium-io/raydium-cp-swap/blob/master/programs/cp-swap/src/instructions/initialize.rs).
- [Uniswap V2 factory](https://github.com/Uniswap/v2-core/blob/master/contracts/interfaces/IUniswapV2Factory.sol): PairCreated.
- [Robinhood conexiones](https://docs.robinhood.com/chain/connecting/): endpoints HTTP/WSS y chain identity.
- [Geth Pub/Sub](https://geth.ethereum.org/docs/interacting-with-geth/rpc/pubsub): nuevas cabeceras, logs, desconexión y reorgs.
- [SQLite WAL](https://sqlite.org/wal.html), [Caddy HTTPS](https://caddyserver.com/docs/automatic-https) y [Docker Ubuntu](https://docs.docker.com/engine/install/ubuntu/).
- Presupuesto y enlaces vigentes: [DEPLOYMENT.md](DEPLOYMENT.md). Los recursos son estimados, no un benchmark de capacidad.
