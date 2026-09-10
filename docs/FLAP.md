# Flap BNB: reconocimiento y adaptador de prueba

La versión 0.3.2 reconoce `TokenBought` y `TokenSold` únicamente desde el Portal BNB oficial `0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0`. Comprueba emisor, token, dirección de la operación, timestamp y transferencias por el mismo importe entre wallet, router y Portal. Los casos ambiguos, con importes distintos o emisores falsificados no habilitan copias.

Esto resuelve el rechazo que intentaba validar una curva Flap mediante `factory()` como si fuera una pool Pancake. El primer tramo del receipt `0xf1cdc757556168f751e817f24388dc90d3cbbcd58361f9e06b0e7697e6f73bd5` no necesita esa suposición.

El campo `eth` del evento puede representar otro ERC20. En ese receipt representa `0x205812cdbed920aff76c6580abd681a46d11efc7`, no el BNB final recibido por el trader. El evento se conserva como evidencia de venta; si falta un trace de la transacción que acredite BNB neto, queda `OBSERVED_SELL` y no se crea una acción de copia. Se mantienen los límites de edad y balance histórico para ventas proporcionales. Un RPC con `missing trie node` sigue impidiendo esas comprobaciones históricas.

Los UNKNOWN antiguos con receipt completo se reclasifican al arrancar. Conservan timestamps y se marcan históricos: jamás se reproducen como compras o ventas nuevas.

## Cotizaciones y simulación

`FLAP_PORTAL` usa `getTokenV8Safe` y `quoteExactInput` mediante RPC real. Restringe swaps a tokens Tradable en bonding curve; usa dirección cero para BNB, cantidad entera, mínimo recibido y conversión nativa habilitada cuando corresponde. La comparación de impacto utiliza una cotización pequeña al mismo bloque, no reservas virtuales presentadas como liquidez real. La antigüedad se cuenta desde que se solicita el bloque de cotización.

PAPER puede elegir esta ruta con su propia cotización y coste de gas estimado. SHADOW construye `swapExactInput`, exige saldo/allowance efectivos y utiliza los controles existentes de `eth_call` y `eth_estimateGas`. El contrato no incluye deadline; el build lo declara expresamente. La ruta está excluida de LIVE, del firmador y del envío automático hasta validar ejecución y reconciliación propias.

## Límites que siguen vigentes

- Las pruebas de reconocimiento reproducen receipts reales proporcionados por el usuario. Los tests de quote/build usan respuestas controladas, y no demuestran ejecución mainnet ni precio actual.
- Una reserva denominada en BNB puede presentarse por su cantidad real, sin multiplicarla como una pool ficticia. Para reservas en otro token no se presume un valor USD. Un mínimo de liquidez configurado puede seguir bloqueando la compra.
- Los tokens migrados requieren una ruta DEX verificada. El adaptador de bonding no asume que `pool` sea una pair: en otros migradores puede ser un Vault/PoolManager.
- Se admiten flujos exactos directos o de un intermediario. Múltiples swaps mezclados, tasas que alteren el importe transferido y rutas más complejas requieren soporte adicional.
- LIVE para esta ruta sigue pendiente de prueba explícita, mínimos efectivos, importes netos de wallet y reconciliación. No se firmó ni transmitió ninguna transacción en esta entrega.

Fuentes oficiales consultadas el 10/09/2026: [contratos](https://docs.flap.sh/flap/developers/deployed-contract-addresses.md), [estado del token](https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/inspect-a-token), [ABI, cotizaciones y eventos](https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/trade-tokens), [impuestos](https://docs.flap.sh/flap/developers/basic-and-mechanism/flap-tax-token/prebond-tax).
