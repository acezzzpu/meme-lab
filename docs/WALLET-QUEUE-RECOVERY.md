# Reparto de la cola de wallets

Una wallet con miles de transacciones antiguas podía ocupar todos los turnos de
`WALLET_TX`. Las notificaciones nuevas y las transacciones de otra wallet quedaban
detrás del historial, incluso con una conexión WebSocket activa.

El planificador alterna ahora entre las wallets con trabajo disponible. Dentro
del turno de cada wallet, prioriza avisos recibidos en los últimos tres minutos:
WebSocket o firmas RPC cuyo `blockTime` también sea reciente. Luego atiende el
historial. Una wallet con tráfico reciente continuo tampoco desplaza los turnos
históricos de otra wallet. Los turnos se guardan como una secuencia en SQLite y
persisten al reiniciar; no dependen de que el reloj avance entre dos llamadas.

Las notificaciones duplicadas conservan su primera fecha de recepción. Un
reinicio no rejuvenece los avisos ni elimina trabajos pendientes. `available_at`
sigue controlando los reintentos y la prioridad de conciliación, salidas y captura
de precios se conserva. La fecha de recepción solo organiza la cola: la transacción
confirmada sigue determinando cuándo ocurrió una operación y si fue una compra
compatible. No cambia el decoder, la validación PAPER ni la habilitación de LIVE.

## Evidencia del diagnóstico

El estado aportado del 10 de septiembre de 2026 a las 20:48:14 UTC mostraba:

- Cuatro tokens MARKET capturando precios, con `market_error: null`, y 48
  trayectorias anteriores excluidas por `PRICE_GAP`.
- 4.201 trabajos pendientes en total. El registro reciente contenía transacciones
  procesadas unos 55 minutos después de su hora on-chain.
- Dos wallets consultadas por RPC, pero una todavía sin transacciones ingeridas.
  Consultar firmas y procesar sus transacciones son pasos distintos.
- Cero compras recientes verificadas. Los timeouts RPC y del scanner seguían
  apareciendo; el arreglo de la cola no demuestra recuperación del proveedor.

Los trabajos antiguos sin metadatos conservan prioridad histórica. La mejora de
actualidad aplica a los avisos recibidos después del despliegue. Conservar el
historial no permite reconstruir los precios que faltaron; las 48 exclusiones
previas no se transforman en ejemplos completos.

## Validación y límites

- Siete pruebas SQLite cubren reparto, prioridad de avisos recientes, recuperación,
  duplicados y conservación de fechas RPC. Seis fallaban antes del cambio.
- Las 199 pruebas pasan con `node --test --test-concurrency=1 tests/*.test.mjs`.
  Dos ejecuciones concurrentes en Windows tuvieron un fallo de limpieza
  `ENOTEMPTY` en pruebas existentes distintas; no fallaron sus aserciones.
- Compilación standalone y TypeScript del destino Render correctos. El chequeo
  TypeScript global conserva el problema previo de `vite.config.ts`, que importa
  un archivo `.openai/hosting.json` ausente en el repositorio.
- En una simulación local de 5.000 trabajos (4.900 de una wallet y 100 de otra),
  los primeros 100 turnos se repartieron 50/50, en 407 ms, conservando los 5.000
  registros. Esto mide el planificador, no la capacidad del RPC en Render.

La cola total puede seguir creciendo si el proveedor procesa menos eventos de
los que llegan. El historial de una misma wallet puede seguir esperando mientras
esa wallet tenga avisos recientes. La cobertura de compras sigue limitada a los
swaps directos exitosos de PumpSwap identificados por el decoder.

Después de desplegar, `/healthz` identifica esta versión como
`0.4.1-wallet-queue-recovery`. Para comprobar el efecto funcional hace falta un
estado autenticado nuevo: ambas wallets deben avanzar y las nuevas transacciones
deben llegar con menor demora. `RUNNING` por sí solo no acredita esa recuperación.
