# MEME LAB · estado de aceptación

Transformación del proyecto existente a motor persistente, septiembre de 2026. **No hay todavía un VPS del usuario contratado/conectado, ensayo de 24 horas ni round trip LIVE financiado.** La web alojada muestra NOT PROVISIONED hasta conectar el servidor real; no fabrica uptime.

## Implementado

- API y proceso del motor separados; supervisor, watchdog, heartbeat, lease y recuperación.
- Cola SQL durable, workers concurrentes, reintentos con espera y checkpoints; posiciones/cash/estrategias sobreviven reinicios.
- WebSockets Solana y Robinhood configurables, ACK, estado parcial, ping, reconexión y recuperación RPC de eventos.
- SSE autenticado con IDs persistidos/reanudación; dashboard automático con Live Engine, mercado, decisiones, trades, posiciones, traders y salud.
- START, pausa/reanudación de entradas, STOP y emergencia. Pausa conserva salidas; STOP no las sigue ejecutando. Órdenes transmitidas siguen reconciliándose.
- PAPER automático Solana con cotización real y capital virtual. Límites/epoch/pausa/duplicación y libro de cash/posiciones protegidos por transacciones SQL.
- Selección de estrategia para propuestas SHADOW/LIVE APPROVAL; aprobaciones y firma siguen siendo explícitas.
- Watch de traders con head separado del cursor histórico, flujos idempotentes y contexto anterior/posterior identificado; patrones descriptivos actualizados en background.
- Docker local/producción, Caddy HTTPS, arranque Windows, backup consistente, retención y guía de instalación/costos.

## Pruebas ejecutadas

**49 tests de lógica pasan**, más TypeScript, compilación standalone y HTTP autenticado. Incluyen pausa con compra pendiente de otro token, salida durante pérdida límite, carrera de pérdida diaria, recuperación/epoch, claim único, replay SSE, discriminador exacto de pool, deduplicación de wallet, rotación de salidas aun con fallos del proveedor, suscripción parcial DEGRADED y refresco de valoración al reconciliar con motor detenido.

Prueba de procesos y proveedores reales: [persistent-engine-verification.json](evidence/persistent-engine-verification.json). El archivo contiene el resultado exacto, duración, slots, proveedores y cotizaciones. Se ejecutó en una base aislada, sin modificar el capital/reglas de la instancia previa.

- Se cerró la conexión SSE y se comprobó progreso del motor sin navegador ni solicitudes API durante 35 segundos.
- Se mató deliberadamente el worker; el supervisor lanzó otro y conservó la sesión PAPER.
- Se reinició API/servidor y se verificaron estado deseado, pausa, cash e inventario almacenado.
- Se recibieron slots reales mediante WSS PublicNode con tres suscripciones reconocidas; ver [evidencia de stream](evidence/network-stream-verification.json). En la última muestra del tercer ensayo, tras reiniciar, WSS seguía CONNECTING: el proveedor público mostró latencia/timeouts, aunque antes había registrado slots reales.
- Se registraron **dos compras y dos ventas PAPER automáticas**, con cotizaciones Jupiter reales. La prueba usa una regla amplia de aceptación y salida temporal de 12 segundos, no una estrategia rentable: ambas vueltas realizaron **−USD 0,11** virtuales, total **−USD 0,22**, incluidos supuestos/minOut. No hubo firma ni envío de capital real.
- Backup SQLite ejecutado sobre la base de prueba: `PRAGMA integrity_check = ok`, sesión y eventos conservados.
- Migraciones aditivas aplicadas dos veces sobre base temporal, sin error; Compose local/producción validado estructuralmente.

Los primeros ensayos no obtuvieron fills y registraron timeouts/rechazos; no se ocultaron generando operaciones sintéticas. Se adelantó el procesamiento de señales para evitar que discovery las envejeciera antes de evaluar la entrada. Los fixtures locales nunca se cargan como actividad de producción.

## Qué está verificado por fuente

| Componente | Evidencia de esta transformación |
|---|---|
| Solana RPC | Identidad/genesis y slots reales; pueden existir timeouts de proveedor público. |
| Solana WSS | Conexión, ACK y notificaciones de slots reales. |
| Creación de pools | Decodificadores y validación de instrucciones probados con fixtures; no se observó una creación en el ensayo breve. No se afirma cobertura completa. |
| DexScreener | Snapshots reales del servidor con precio/contexto/hora de recepción. Es REST, no cada swap/tick. |
| Jupiter PAPER | Cotizaciones reales para BUY y SELL, libro virtual y fees/minOut registrados. |
| Robinhood | Adaptador HTTP preexistente; WSS nuevo implementado/configurable, sin credencial ni conexión WSS real verificada en este ensayo. |
| Watch/learning | Persistencia, deduplicación, paginación y contexto probados. No se afirma un trader observado comprando durante este ensayo ni un modelo ML entrenado. |
| Docker/VPS/HTTPS | Archivos preparados. Docker no está instalado aquí; no se ejecutó contenedor ni emisión de certificado del usuario. |
| LIVE | Código conservado y pruebas de estados/firma/reconciliación pasan; ningún swap financiado ejecutado. LIVE AUTO bloqueado. |

## Límites materiales

No se completan todavía cartera SHADOW con salidas/comparación de fills, TP1/TP2 parciales configurables, ML/calibración de traders, import integral D1→VPS, cobertura exhaustiva de pools ni rollback completo de reorgs. Backfill depende de la retención/cuota del proveedor. No hay failover de hosts, backups externos programados ni auditoría independiente.

El servidor está diseñado para permanecer encendido, pero una prueba de minutos no demuestra 24/7 estable. Debe instalarse en PC/VPS duradero y realizar un ensayo prolongado con sus proveedores. La base alojada antigua y la del servidor son independientes; configurar el puente remoto permite usar una sola base central desde cualquier Chrome.

Instrucciones: [README](../README.md). Infraestructura, costo, despliegue y comprobación al cerrar Chrome: [DEPLOYMENT](DEPLOYMENT.md). Pendientes: [ROADMAP](ROADMAP.md).

## Corrección de acceso 0.2.1

Se reprodujo HTTP 403 al abrir la UI desde un enlace externo. La excepción permite únicamente GET de navegación superior hacia el documento público; no permite requests cross-site a API/SSE/login ni POST. Los 16 casos HTTP de `scripts/verify-navigation.mjs` pasan, incluido acceso normal autenticado y rechazo sin sesión. Evidencia: [navigation-verification.json](evidence/navigation-verification.json). La corrección del paquete no modifica automáticamente la copia instalada en la PC; escribir la URL directamente permite continuar con la versión anterior.

## Corrección de pantalla en blanco en Windows 0.2.2

Reproducido con `path.win32`: el guard anterior permitía el documento raíz pero rechazaba los bundles JavaScript y CSS por mezclar separadores de ruta. La resolución utiliza ahora `path.relative` y el separador del sistema; conserva el rechazo de rutas que escapan del directorio público. Assets ausentes responden 404.

Cinco pruebas de rutas POSIX/Windows pasan y 21 verificaciones HTTP pasan, incluyendo el contenido y MIME exactos de los JS/CSS referenciados por el HTML, rutas SPA, login, controles autenticados y restricciones cross-site. Evidencia actualizada: [navigation-verification.json](evidence/navigation-verification.json). No se ejecutó Windows de escritorio en este entorno. El ZIP pequeño reemplaza sólo `runtime/server.mjs` y añade `runtime/static-path.mjs`; no contiene base de datos, token ni dependencias. La instalación en la PC requiere aplicar el parche y reiniciar su consola.

## Proveedores lentos y límites 429 · corrección 0.2.3

Se agregó un presupuesto por proveedor y proceso: como máximo dos requests simultáneos, separación entre consultas y espera compartida cuando llega 429/503, respetando Retry-After. No se reenvían automáticamente POST ni transacciones. Timeouts producen espera creciente y el siguiente trabajo durable vuelve a intentar. El presupuesto HTTP se reinicia con el proceso; los trabajos y sus reintentos siguen persistidos.

Mercado agrupa hasta dos direcciones por consulta DexScreener, comparte peticiones simultáneas del mismo token y reutiliza observaciones menores de cinco segundos sin cambiar su timestamp. Discovery se consulta como máximo una vez por minuto tras una respuesta exitosa. Los tokens descartados por la estrategia ya no consumen RPC de metadata.

USDC se refresca antes de discovery y desde el monitor PAPER aunque no existan posiciones. Un slot de trabajo queda reservado para precios/salidas o reconciliación cuando hay al menos dos workers configurados. Se mantiene el límite de 45 segundos: tras cotizar, se vuelve a comprobar la edad de USDC y de la señal/precio de salida. No se fija USDC artificialmente en USD 1. Las entradas sin señales no generan avisos repetidos.

Live Engine muestra MERCADO por separado del estado del motor y de Solana. Una conexión WebSocket activa no demuestra que precios o RPC estén disponibles.

**Pruebas:** 67 tests pasan, incluyendo 13 regresiones de recuperación; TypeScript, build standalone y carga HTTP verificados. En una prueba real de 36 segundos, el worker actualizó USDC dos veces con cartera vacía, recibió slots Solana por WSS y mantuvo USD 100 PAPER intactos, con entradas pausadas y sin navegador. Ver [evidencia](evidence/provider-recovery-verification.json). No demuestra estabilidad de 24 horas ni disponibilidad en la conexión del usuario.

**Actualizar Windows:** cerrar la consola, extraer `meme-lab-actualizacion-023.zip` y copiar todo su contenido dentro de la carpeta original donde está `Iniciar-MEME-LAB.cmd`, aceptando reemplazar. Abrir de nuevo ese lanzador y recargar Chrome con Ctrl+F5. Se conservan `.runtime`, el token, las sesiones, los balances y las posiciones. Los proveedores y modos no se cambian automáticamente. No hace falta reinstalar dependencias.

El RPC público de Solana publica límites y advierte que no está destinado a aplicaciones de producción: https://solana.com/docs/references/clusters . DexScreener es una fuente diferente: cambiar sólo el RPC no elimina sus fallos. La corrección reduce la carga interna; no elimina cuotas ni interrupciones externas.
