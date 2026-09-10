# Actualización 0.3.1

Si ya tenés Copy Trading instalado, seguí [ACTUALIZAR-031.md](ACTUALIZAR-031.md). Corrige el atraso de la cola y agrega el diagnóstico del motor. Las validaciones de la versión 0.3.0 descriptas abajo son antecedentes; la actualización tiene sus propias pruebas documentadas.

# MEME LAB 0.3.0 — Copy Trading BNB

Actualización del proyecto existente, 10 de septiembre de 2026. La nueva opción del menú es **Copy Trading**. El target inicial es `0x80a65fcaeabbb0aa4c9a85087f9e0f7ba26f293f`.

**Incluye ejecución con dinero real, pero todavía no está validada una compra/venta nuestra en mainnet ni la velocidad de producción.** No se enviaron fondos durante este trabajo. El modo inicial es PAPER; LIVE requiere wallet dedicada, proveedor compatible, límites y activación explícita. El apartado Validación muestra evidencia de tu instalación, sin cargar operaciones de ejemplo.

## Instalar la actualización en tu PC Windows

1. En MEME LAB, usá **STOP COPY** si ya aparece. Cerrá el proceso de la consola con **Ctrl+C**. Esperá a que termine.
2. Hacé una copia de tu carpeta MEME LAB como respaldo. Conservá especialmente `.runtime` —base, posiciones y token— y `.env`.
3. Extraé `meme-lab-actualizacion-030.zip`. Copiá **su contenido** dentro de la carpeta existente que contiene `package.json` e `Iniciar-MEME-LAB.cmd`. Aceptá reemplazar archivos. No borres `.runtime` ni `.env`; el ZIP no los contiene.
4. Ejecutá **Iniciar-MEME-LAB.cmd**. Este instala dependencias y recompila el panel. La base agrega las nuevas tablas al iniciar; conserva las anteriores.
5. Abrí **http://localhost:8787**. Usá tu token habitual si lo pide. Presioná **Ctrl+F5** una vez para cargar el panel actualizado.
6. Menú izquierdo → **Copy Trading** → **Latencia y conexiones** → **Agregar HTTP + WSS**. Pegá los endpoints de BSC mainnet de tu proveedor. Las credenciales se guardan cifradas.
7. **Targets → Editar**: dejá PAPER y revisá tamaño por entrada y salida. La salida predeterminada copia el porcentaje vendido del inventario propio.
8. Presioná **START COPY** una vez. Mirá **Actividad y posiciones**. Las transacciones del target, decisiones y copias son listas distintas: observar una transacción no significa haberla comprado.

No hace falta reinstalar Node si ya tenés la versión usada por el motor anterior. Se requiere Node **24.19 o posterior** compatible y npm. El comando manual es `npm run build:standalone` y luego `npm run engine`.

## Qué está implementado y qué está probado

| Componente | Estado y límite práctico |
|---|---|
| Motor servidor, cola SQLite, API, SSE, recuperación y emergencia | **LOCALLY TESTED** con procesos reales: conexión SSE cerrada, worker interrumpido y recuperado, servidor reiniciado, saldo/posición/ledger preservados. Prueba corta de 27 segundos; no es una prueba de 24 horas. |
| Clasificación de transacciones y autenticación de pools | **LOCALLY TESTED** con regresiones y replay de dos receipts reales del target. Transferencias, aprobaciones y operaciones fallidas no son compras. |
| BSC HTTP y datos de blockchain | Lecturas reales de chain 56, bloques, transacciones, receipts y pools verificadas. Pruebas de conectividad completas en `docs/evidence/bnb-target/`. |
| WebSocket BSC, reconexión, logs y fallback HTTP | **IMPLEMENTED**, con pruebas locales de estados y fallback. No se logró una suscripción WSS externa exitosa en este entorno. Debe comprobarse con tu endpoint. |
| Cotizaciones Pancake V2/V3 | Cotizaciones V3 BUY/SELL reales respondieron. El ensayo completo del adaptador se interrumpió por transporte antes de cotizar; no se etiqueta como validado de extremo a extremo. |
| PAPER, ventas parciales, reentrada, fees, frenos y no duplicación | **LOCALLY TESTED** con proveedores controlados en pruebas; cotizaciones reales verificadas por separado. Todavía no hay copia PAPER de ese target validada durante una sesión continua real. |
| SHADOW con `eth_call` y `eth_estimateGas` | **LOCALLY TESTED** el circuito. **SHADOW VALIDATED pendiente** en una wallet real con balance/allowance suficientes. No inventa balances mediante state overrides. |
| Firmador separado, destinatario, monto, calldata y STOP | **LOCALLY TESTED** con firmas EVM reales de claves efímeras sin fondos. No se transmitieron. |
| LIVE APPROVAL / LIVE AUTO | **IMPLEMENTED**, guardas y recuperación probadas localmente. **MAINNET MICRO-TEST VALIDATED pendiente**. AUTO permanece bloqueado hasta reunir evidencia. |
| Testnet | **NO VALIDADO**. No se presentó una prueba en otra red como sustituto de liquidez o rutas BSC mainnet. |
| PnL y win rate completos del trader, clasificación humano/bot, rentabilidad copiable | **NO IMPLEMENTADO como análisis histórico completo**. Se conserva evidencia, comparación por operación y un porcentaje de ejecución explicado; no se atribuye rentabilidad desconocida. |
| Contratos adicionales/launchpads no autenticados y 0x LIVE | **NO SOPORTADOS** para ejecución LIVE en esta versión. Se rechazan. |
| Recuperación automática de contabilidad después de una reorganización confirmada | Detecta, conserva evidencia y detiene; la resolución contable requiere revisión. No hay rollback automático de operaciones ejecutadas. |

Las pruebas sintéticas sólo están en `tests/` y scripts de verificación con bases temporales. No se insertan en la base de producción. Las capturas reales sólo se incluyen como archivos de evidencia.

## Lo que encontramos en la wallet elegida

Dos compras reales exitosas, ambas enviando 0,01 BNB al agregador `0x1de460f363af910f51726def188f9004276bf4bc`:

| UTC | Token | Evidencia | Cobertura |
|---|---|---|---|
| 05:24:37 | 7BALL `0x7f161c27dc558170f797d856539689b48ae47777` | [Receipt BUY](https://bscscan.com/tx/0x4f1caec89492578df33b2b1f7864d8155ac824a9c65f41fd66956630470dcb20) | Dos saltos Pancake autenticados y un último contrato sin autenticar. El sistema lo rechaza. |
| 05:29:06 | Test `0x8dd50128acb78102743ba65553f55793e9ee7d10` | [Receipt BUY](https://bscscan.com/tx/0xba845a505ed4c648988d9c55435317fcef6014adb5cc3854c8e2b26b74f3c445) | WBNB → BREW → Test; dos pools V3 autenticadas, fee 1% cada una. Ruta propia implementada. |

Esta muestra **no representa todo el historial**. No se capturó una venta del target. El valor enviado está probado; su coste nativo neto, incluyendo eventuales devoluciones internas, no pudo reconstruirse porque el RPC público devolvió `missing trie node` al pedir trace. PAPER marca esa estimación; LIVE exige evidencia exacta.

Dos consultas reales posteriores al QuoterV2 devolvieron:

- 0,002 BNB → 8.130,136731216550771007 unidades de Test.
- Cotizar la venta de esas unidades → 0,001938947693301603 BNB.

Fueron consultas separadas al estado disponible entonces: **no hubo compra ni venta ejecutada, ni se aplicó el impacto de una compra nuestra al consultar la salida**. No representan PnL realizado. Respuestas sin procesar: `docs/evidence/bnb-target/quote-pair.json`.

## Proveedor y velocidad

Para esta wallet se necesita un endpoint **BNB Smart Chain mainnet, chain ID 56**, con:

- HTTPS RPC y WSS `eth_subscribe` para `newHeads` y logs de transferencias.
- `eth_getTransactionByHash`, receipts, bloques completos, `eth_call`, `eth_estimateGas`, gas y nonce pendientes.
- `debug_traceTransaction` con `callTracer`, para separar valor enviado, devoluciones y ventas nativas.
- Lectura histórica reciente `balanceOf` y `eth_getLogs`, para medir el porcentaje vendido sin mezclar otras transacciones del bloque.

**QuickNode BSC es un candidato concreto**: documenta `debug_traceTransaction` y `callTracer`; verificá en su plan el acceso histórico y los límites de WSS antes de contratar. [Documentación del método](https://www.quicknode.com/docs/bnb-smart-chain/debug_traceTransaction). No se contrató ni probó un plan pago en este trabajo. No se promete una tarifa o cuota que no se haya confirmado.

El RPC público oficial sirve para lecturas iniciales; sus restricciones no alcanzan para garantizar copia veloz ni porcentajes históricos. La documentación BNB indica restricciones de `eth_getLogs`: [endpoints oficiales](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/).

En este entorno hubo unos **9–11 segundos por consulta pública**, timeouts y una conexión WSS fallida. Es una medición del proveedor **más el transporte de este entorno**, no una medición desde tu PC. Los defaults rechazan señal de más de 2.000 ms y quote de más de 1.500 ms; esos ensayos lentos no autorizarían operar. No aumentes límites para ocultar una mala conexión: primero medí el RPC desde el equipo que ejecutará el bot.

La detección no espera la web ni el scanner Solana. Pool metadata autenticada y rutas se cachean; las consultas independientes se realizan en paralelo. Cada copiado verifica edad, precio, capital y simulación antes de firmar y antes de transmitir. **No se promete entrar en el mismo bloque**: pending se muestra, pero la ejecución espera un receipt. Las transacciones privadas no son visibles en todo mempool.

En **Latencia y conexiones → Benchmark RPC** aparecen resultados guardados. Los percentiles de detección/copia necesitan eventos reales suficientes; nunca se llenan con valores de ejemplo. La precisión temporal del bloque es de un segundo.

## Configurar tu wallet de ejecución

La wallet del trader sólo se observa. Tu dinero va en **otra wallet, dedicada al copiador**.

1. Abrí una terminal dentro de la carpeta MEME LAB y ejecutá:

   ```powershell
   npm run copy:wallet
   ```

2. El comando genera una wallet, un keystore cifrado y una contraseña aleatoria en `MEME-LAB-Secrets` dentro de tu carpeta de usuario. En Windows restringe la carpeta a tu usuario mediante ACL. Si ya existe, conserva la wallet; no la reemplaza. Guarda automáticamente las rutas en `.env` y muestra **sólo la dirección pública**.
3. Hacé un backup privado de ambos archivos. Se necesitan para recuperar la wallet. No los pegues en el chat, navegador o repositorio.
4. Reiniciá la consola del motor. **Copy Trading → Capital y wallet**: pegá la dirección pública y guardá los límites. **Execution Wallet → Signer** debe mostrar CONNECTED y la misma dirección.
5. Revisá PAPER, después SHADOW. Una simulación real SHADOW puede necesitar balance y allowance: si faltan, lo informa y no se declara validada.
6. Para una prueba financiada, revisá el monto máximo, presupuesto de gas, token/ruta y salida prevista; activá **LIVE con aprobación**, cambiá el target a **LIVE_APPROVAL** y aprobá sólo una copia vigente que hayas decidido ejecutar. La activación por sí sola no envía fondos. No hay una transacción mainnet preautorizada por esta entrega.
7. Una aprobación de ERC20 también es una transacción con gas. El sistema permite reset a cero y permiso por cantidad exacta; verifica que el permiso se haya aplicado. No otorga una aprobación ilimitada.
8. Una compra y salida propias confirmadas del mismo target/token quedan como evidencia. AUTO exige además 20 trades del target con compras/ventas, 10 fills PAPER con tres salidas y una simulación SHADOW. Este filtro técnico no demuestra ganancia futura.

Para una copia manual aprobada, la señal puede vencer antes de que hagas clic; el sistema rechaza la aprobación vieja. No transforma una aprobación vieja en una operación nueva.

El keystore y su archivo de contraseña quedan en el mismo equipo para permitir arranque desatendido. Quien controle ese usuario del sistema puede controlar esos fondos; usá una wallet dedicada y los límites configurados. Las claves no pasan por la UI.

## Dónde ver cada cosa

- **Actividad y posiciones**: transacción fuente, BUY/SELL, decisión/rechazo, operación propia, posiciones, PnL y detalles de evidencia. Las operaciones PAPER no tienen hash de ejecución on-chain.
- **Targets**: agregar wallets, tamaños y política de salida. Importar historial requiere API Etherscan V2 con acceso BSC; el botón no ejecuta transacciones históricas.
- **Target vs us**: precio fuente, quote propia, diferencia y seguimientos reales T+30/T+60 cuando el proveedor responde. Muestra el retraso real, no precios históricos inventados.
- **Latencia y conexiones**: proveedor, estado, errores, benchmark y cobertura observada de routers.
- **Execution Wallet**: dirección, balance real, signer y activación LIVE.
- **Validación**: requisitos reunidos y pendientes en tu base.

**Copyability** es `100 × copias PAPER aceptadas / intentos observados`, sólo tras 20 muestras. No es un score de rentabilidad y no incluye como éxito contratos que no se decodifican. La cobertura de la wallet completa permanece desconocida.

## Cómo comprobar que sigue sin Chrome

1. Anotá la hora de tu PC y el último bloque guardado de Copy Trading.
2. Cerrá Chrome, dejando la consola abierta y la PC encendida, sin suspensión.
3. Esperá unos minutos, abrí otra vez `http://localhost:8787` y revisá los bloques/eventos y tiempos. Usá **Exportar evidencia** para conservar los registros anteriores, aunque el feed sólo enseñe los últimos.
4. La existencia de transacciones fechadas durante ese intervalo demuestra actividad en ese intervalo. Que diga RUNNING o que el contador crezca por sí solo no demuestra que haya podido comprar o vender.

Cerrar la consola, apagar la PC o suspender Windows interrumpe el servidor. Reiniciar el motor conserva la base. Tras reinicio, PAPER puede recuperar monitoreo; LIVE se desarma y requiere reactivación. Un envío incierto conserva el mismo hash/nonce: no se repite automáticamente.

## VPS y acceso remoto

Para una wallet y una instancia, estimación inicial de capacidad: **2 vCPU, 4 GB RAM, SSD de 40 GB**, Linux y conexión estable. Un equipo con 8 GB facilita builds y retención de logs. No hace falta alojar un nodo completo BSC. Medí consumo y crecimiento de SQLite antes de ampliar el número de targets. Esto es capacidad orientativa, no un benchmark de carga realizado.

Necesitás contratar un VPS si no querés dejar la PC encendida, un RPC BSC compatible y un dominio si querés una URL propia. SQLite está incluido; no requiere contratar una base separada para esta instancia. El historial ampliado mediante Etherscan es un servicio opcional aparte.

En un VPS con Docker y Compose:

```bash
cp .env.production.example .env.production
# Editar DOMAIN y CONTACT_EMAIL con tu dominio y correo.
docker compose --env-file .env.production -f compose.production.yaml up -d --build
docker compose --env-file .env.production -f compose.production.yaml logs --tail=100 meme-lab
```

Apuntá el DNS del dominio al VPS y habilitá 80/443. Caddy proporciona HTTPS. No expongas 8787 públicamente. Los volúmenes `meme-data` y `meme-backups` conservan datos. Nunca uses `down -v` al actualizar.

Para el firmador del contenedor, prepará los secretos privados en el host, legibles únicamente por el usuario que ejecuta el servicio; el contenedor usa uid 1000. Agregá `BNB_SECRET_DIR` en `.env.production` y usá:

```bash
docker compose --env-file .env.production -f compose.production.yaml -f compose.copy-live.yaml up -d --build
```

El override monta la carpeta de secretos sólo para lectura. La UI publicada y el servidor local son instalaciones distintas salvo que configures el proxy remoto existente de MEME LAB. La entrega no despliega un VPS ni cambia automáticamente tu instalación Windows.

## Arquitectura y límites de ejecución

API Node → supervisor → worker persistente → carril Copy BNB → observaciones WSS/HTTP → cola SQLite → clasificación de receipt → pools autenticadas → quote propia → riesgo/capital → PAPER, SHADOW o firmador aislado → envío único → reconciliación de receipt. La API emite SSE al panel. Los jobs y ledgers no viven en Chrome.

Los modos comparten límites de capital, exposición, posiciones, pérdidas, gas, slippage, antigüedad y diferencia de precio. PAUSE ENTRIES mantiene salidas; STOP/EMERGENCY no revierte una transacción ya emitida y sigue reconciliando su resultado. SmartRouter bloquea tokens con impuestos no nulos o desconocidos; las variantes V2 compatibles con transfer fees aplican mínimo neto. Contratos no autenticados se rechazan; no se reutiliza el calldata del target.

La fuente y nuestra operación tienen identificadores distintos. Cantidades y costes se conservan como enteros decimales en SQLite. La venta parcial usa la proporción del saldo fuente anterior; si ese saldo no puede reconstruirse, la copia proporcional queda bloqueada. Reentradas suman inventario propio. No vende tokens que no están registrados en el copiador.

No se implementaron estrategias sofisticadas de puja MEV, bundles privados, venta forzada de contratos desconocidos, inferencia de identidad humana, ni un historial global completo del trader. La retención de eventos y el dimensionamiento a muchas wallets necesitan una prueba de carga; no se afirma capacidad ilimitada.

La verificación final dio **108/108 pruebas**, TypeScript y ambos builds correctos. El instalador y los permisos ACL no se ejecutaron en Windows durante esta entrega; la integración de procesos se probó en Linux.

## Reproducir las pruebas

```bash
npm test
npm run copy:verify:signer
npm run copy:verify:runtime
npm run build:standalone
```

La prueba de runtime con interrupción del worker usa `/proc` y requiere Linux. Los scripts usan bases temporales y cero fondos; la prueba de firma genera claves efímeras. La suite de regresiones no requiere RPC. Las lecturas de mainnet están documentadas con respuestas archivadas; volver a ejecutar pruebas de replay no es una nueva validación de mainnet.

Fuentes técnicas: [Pancake direcciones](https://developer.pancakeswap.finance/contracts/v3/addresses), [SmartRouter V3](https://developer.pancakeswap.finance/contracts/v3/smartrouter/v3swaprouter), [SmartRouter V2](https://developer.pancakeswap.finance/contracts/v3/smartrouter/v2swaprouter), [Geth suscripciones](https://geth.ethereum.org/docs/interacting-with-geth/rpc/pubsub), [DexScreener API](https://docs.dexscreener.com/api/reference), [GoPlus seguridad](https://docs.gopluslabs.io/reference/response-details), [Etherscan historial](https://docs.etherscan.io/api-reference/endpoint/txlist).
