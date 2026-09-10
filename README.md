# Actualización 0.3.0: Copy Trading BNB

El apartado **Copy Trading** agrega monitoreo BSC persistente, PAPER/SHADOW y ejecución LIVE con firmador dedicado. [Instalación, evidencia y límites reales](docs/COPY-TRADING-BNB.md). No hay microprueba financiada validada todavía.

# MEME LAB · motor persistente

La web es el panel. El bot corre en un proceso Node separado y supervisado, con SQLite WAL, trabajos durables y conexiones independientes de Chrome. “Consultar ahora” dejó de ser el mecanismo normal: quedó una consulta de diagnóstico en Scanner.

Ver [estado probado y límites](docs/COMPLETION.md) y [despliegue 24/7](docs/DEPLOYMENT.md). No se afirma estabilidad de 24 horas ni ejecución LIVE financiada a partir de una prueba corta.

## Arrancar en PC

Instalar Node.js 24.19 o superior compatible. En Windows abrir **Iniciar-MEME-LAB.cmd**. En Linux/macOS:

```bash
npm ci
npm run build:standalone
npm run engine
```

Abrir `http://localhost:8787`. Ingresar el contenido de `.runtime/admin-token`, generado en el primer arranque; en Windows abrirlo con Bloc de notas. La consola y la PC deben seguir encendidas, sin suspensión. Chrome puede cerrarse.

1. **Settings → Networks:** verificar RPC y configurar WSS. El nuevo RPC se prueba antes de guardarse. Un cambio exitoso invalida las sesiones/aprobaciones anteriores.
2. **Strategy Lab:** crear estrategia. No se aflojan filtros de producción para forzar compras.
3. **Run Bot → PAPER:** crear sesión virtual y pulsar **START ENGINE**.
4. **Dashboard:** ver decisiones, posiciones, Live Trades, traders y errores. Cero compras es válido si faltan señales o cotizaciones utilizables.
5. **Traders:** agregar wallet pública. Queda vigilada hasta desactivar Watch. El análisis histórico manual es adicional.

**RUNNING** describe el proceso; cada proveedor tiene estado propio. Una red puede estar caída mientras el motor sigue activo.

## Controles

| Control | Efecto durable |
|---|---|
| START ENGINE | Activa conexiones/trabajos, conserva capital y posiciones. Después de STOP las entradas permanecen pausadas hasta reanudarlas. |
| PAUSE NEW ENTRIES | Bloquea compras y cancela compras preparadas sin envío; las salidas siguen vigiladas. |
| RESUME ENTRIES | Permite nuevas entradas sujetas a estrategia y riesgo. |
| STOP ENGINE | Detiene conexiones, análisis y nuevas operaciones. Conserva posiciones; no las liquida ni sigue cerrándolas automáticamente. |
| EMERGENCY STOP | Además detiene sesiones e invalida aprobaciones. Transacciones ya transmitidas siguen reconciliándose. |

No se permite cambiar de modo con posiciones abiertas. Para detener entradas sin abandonar salidas usar pausa. PAPER queda fijado a su versión de estrategia.

## Modalidades

| Modo | Implementación actual |
|---|---|
| OBSERVE | Mercado, pools, decisiones y traders; sin órdenes. |
| PAPER | Entradas/salidas virtuales automáticas Solana con cotizaciones Jupiter reales, mínimo de salida y costes registrados. |
| SHADOW | Señales Solana generan preparación/simulación sin firma/envío. Requiere wallet y activos para simular. No hay cartera SHADOW completa ni comparación continua de fills. |
| LIVE APPROVAL | Estrategia seleccionada propone entradas/salidas. Cada orden exige aprobación y firma. Round trip financiado todavía pendiente. |
| LIVE AUTO | Bloqueado hasta validar ejecución financiada y operación autónoma. |

No se habilitó ni usó dinero real en esta transformación. PAPER es virtual aunque su cotización sea real; no prueba que un swap hubiera llenado ese precio.

## Fuentes y tiempos

- **Solana WSS:** slots y logs de PumpSwap, Raydium CPMM y wallets vigiladas. Las pools se verifican por transacción, programa y bytes de instrucción; un slot no se etiqueta como pool.
- **Robinhood WSS:** bloques `newHeads` y eventos `PairCreated` del factory V2 configurado, si se configura endpoint compatible. El feed del secuenciador no es JSON-RPC WSS.
- **Mercado REST:** DexScreener entrega precios, liquidez, market cap, volumen y buys/sells agregados. El servidor consulta y registra hora de recepción; no es cada tick ni cada swap de toda la red.
- **Traders:** Solana notificaciones + recuperación RPC paginada; Robinhood Blockscout + receipts. Flujos con activo cotizado opuesto se marcan inferidos. Contextos posteriores nunca se presentan como anteriores al trade.
- **Web SSE:** autenticado, IDs persistentes y reconexión. El reloj del navegador muestra edad/uptime; no genera trades.

Scanner cada 15 s después de terminar el ciclo previo, por defecto 12 tokens con rotación. Salidas PAPER en trabajo separado cada 5 s, lotes rotativos de dos posiciones. Los tiempos efectivos dependen de proveedor/cola. System Health muestra las demoras.

## Recuperación y datos

API/supervisor lanzan un proceso hijo. Un lease evita dos motores activos sobre la misma base. Watchdog reinicia procesos sin heartbeat o con trabajos bloqueados. Docker reinicia el servicio completo tras una caída del host.

SQLite guarda sesiones, cash, posiciones, versiones, eventos, trabajos y checkpoints. Reiniciar reencola trabajos interrumpidos, invalida órdenes sin transmitir y conserva envíos inciertos para consultar su signature original. LIVE reinicia con entradas pausadas. No se reconstruye otra compra para resolver un timeout.

Logs y snapshots no referenciados se retienen 7 días por defecto. Posiciones, órdenes, ledger y contextos de aprendizaje permanecen; vigilar crecimiento del disco. El backfill depende del historial del proveedor y la capacidad de cola; no hay garantía de cobertura exhaustiva ni rollback completo ante reorgs.

## Pruebas y backup

```bash
npm test
npx tsc --noEmit
npm run build:standalone
node scripts/verify-http.mjs
npm run test:engine
npm run backup -- /ruta/protegida/backup-fecha
```

`test:engine` usa base aislada y dinero virtual. Arranca API+worker, recibe SSE, desconecta cliente, mata el worker, verifica recuperación, reinicia API y revisa saldo/sesiones. Intenta PAPER con reglas amplias explícitamente de aceptación; si el proveedor falla, registra la limitación sin insertar fills inventados. Evidencia: [persistent-engine-verification.json](docs/evidence/persistent-engine-verification.json).

Backup usa la copia consistente de SQLite aun con servidor activo y copia claves generadas con permisos restringidos. Si la clave viene de `ENCRYPTION_KEY`, conservarla aparte. Restaurar con servicio detenido: conservar copia actual, reemplazar database y claves correspondientes, quitar WAL/SHM antiguos y arrancar. Un backup antiguo no revierte blockchain: reconciliar antes de reactivar LIVE. Export JSON omite secretos y limita 10.000 filas por tabla; no sustituye backup.

## Acceso desde cualquier PC

Desplegar según [DEPLOYMENT.md](docs/DEPLOYMENT.md) y abrir la URL HTTPS del VPS. También se puede conectar la web publicada a esa API mediante `REMOTE_ENGINE_URL` y `REMOTE_ENGINE_TOKEN`, secretos del alojamiento. Sin backend remoto muestra **NOT PROVISIONED**: el alojamiento de la página no ejecuta el daemon.

La D1 antigua y la base del VPS son independientes. No hay sincronización/importador completo de sesiones previas. Operar desde una sola instancia central. No ingresar seeds/private keys en chat ni formularios; los signers locales usan archivos protegidos y Solana también admite firma mediante extensión de wallet.

## Acceso desde un enlace · corrección 0.2.1

La versión 0.2.0 podía responder `CROSS_SITE_REQUEST_REJECTED` al abrir el panel local desde otra página. Para entrar con esa instalación, abrir una pestaña nueva y escribir `http://localhost:8787` en la barra de direcciones. La versión 0.2.1 permite la navegación al documento público y conserva el bloqueo cross-site de API, SSE, login, controles e iframes. Verificación reproducible: `node scripts/verify-navigation.mjs` (16 casos HTTP).

## Pantalla en blanco en Windows · corrección 0.2.2

La comprobación de archivos usaba `/` para un directorio que Windows representa con `\`. El HTML abría, pero los JS/CSS respondían `PATH_REJECTED`, dejando la interfaz vacía. Se corrigió la comprobación con las reglas de ruta del sistema operativo. Los assets inexistentes ahora devuelven 404, sin ocultarlos detrás del HTML.

Para una instalación 0.2.0/0.2.1: cerrar la consola de MEME LAB, extraer `meme-lab-windows-fix.zip` y copiar sus dos archivos de `runtime` dentro del `runtime` de la instalación original, aceptando reemplazar `server.mjs`. Volver a abrir `Iniciar-MEME-LAB.cmd` y entrar a `http://localhost:8787`. No borrar `.runtime`: contiene los datos y el token. No hace falta reinstalar Node ni dependencias.

Pruebas: `node --test tests/static-path.test.mjs` (5 casos POSIX/Windows) y `node scripts/verify-navigation.mjs` (21 comprobaciones HTTP, incluidos archivos JS/CSS reales). El entorno de prueba es Linux con reglas `path.win32`; no se ejecutó una PC Windows de escritorio.

## Proveedores lentos y límites 429 · corrección 0.2.3

Se agregó un presupuesto por proveedor y proceso: como máximo dos requests simultáneos, separación entre consultas y espera compartida cuando llega 429/503, respetando Retry-After. No se reenvían automáticamente POST ni transacciones. Timeouts producen espera creciente y el siguiente trabajo durable vuelve a intentar. El presupuesto HTTP se reinicia con el proceso; los trabajos y sus reintentos siguen persistidos.

Mercado agrupa hasta dos direcciones por consulta DexScreener, comparte peticiones simultáneas del mismo token y reutiliza observaciones menores de cinco segundos sin cambiar su timestamp. Discovery se consulta como máximo una vez por minuto tras una respuesta exitosa. Los tokens descartados por la estrategia ya no consumen RPC de metadata.

USDC se refresca antes de discovery y desde el monitor PAPER aunque no existan posiciones. Un slot de trabajo queda reservado para precios/salidas o reconciliación cuando hay al menos dos workers configurados. Se mantiene el límite de 45 segundos: tras cotizar, se vuelve a comprobar la edad de USDC y de la señal/precio de salida. No se fija USDC artificialmente en USD 1. Las entradas sin señales no generan avisos repetidos.

Live Engine muestra MERCADO por separado del estado del motor y de Solana. Una conexión WebSocket activa no demuestra que precios o RPC estén disponibles.

**Pruebas:** 67 tests pasan, incluyendo 13 regresiones de recuperación; TypeScript, build standalone y carga HTTP verificados. En una prueba real de 36 segundos, el worker actualizó USDC dos veces con cartera vacía, recibió slots Solana por WSS y mantuvo USD 100 PAPER intactos, con entradas pausadas y sin navegador. Ver [evidencia](docs/evidence/provider-recovery-verification.json). No demuestra estabilidad de 24 horas ni disponibilidad en la conexión del usuario.

**Actualizar Windows:** cerrar la consola, extraer `meme-lab-actualizacion-023.zip` y copiar todo su contenido dentro de la carpeta original donde está `Iniciar-MEME-LAB.cmd`, aceptando reemplazar. Abrir de nuevo ese lanzador y recargar Chrome con Ctrl+F5. Se conservan `.runtime`, el token, las sesiones, los balances y las posiciones. Los proveedores y modos no se cambian automáticamente. No hace falta reinstalar dependencias.

El RPC público de Solana publica límites y advierte que no está destinado a aplicaciones de producción: https://solana.com/docs/references/clusters . DexScreener es una fuente diferente: cambiar sólo el RPC no elimina sus fallos. La corrección reduce la carga interna; no elimina cuotas ni interrupciones externas.
