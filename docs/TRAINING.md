# Entrenamiento de estrategias con wallets

Versión 0.4.0. En la nube, abrir **Watched Traders → Add wallet**, agregar las direcciones Solana y luego **Entrenamiento → INICIAR ENTRENAMIENTO**. No requiere reinstalar la PC. La configuración y los datasets quedan en el disco de Render. No hay un modelo rentable precargado.

## Qué aprende

El servidor ajusta reglas de liquidez, capitalización, volumen, proporción compras/ventas, momentum y edad de la pool. Busca entre hasta 25 candidatas con distintos stop loss, take profit y tiempo máximo de tenencia. Los umbrales se calculan exclusivamente con ejemplos del periodo de entrenamiento, y la selección utiliza resultados después de costes. Es una búsqueda de parámetros entrenada con datos, no una red neuronal ni una reconstrucción de la intención privada de un trader.

Los datos incluyen tokens adquiridos por las wallets y un grupo de tokens observados por el scanner. Se reserva capacidad para ambos grupos, con hasta ocho trayectorias simultáneas. El servidor solicita precios de cuatro tokens cada 15 segundos; los límites, caídas y latencia del proveedor pueden producir huecos. El trabajo tiene su propia cola persistente, sin depender del navegador.

La cobertura inicial de compras verificadas es **Solana, instrucciones directas de PumpSwap**. Se comprueba el programa, discriminador, wallet, cuenta receptora, dirección del cambio de tokens y resultado exitoso. Se excluyen CPI/routers agregadores, rutas desconocidas, fallos, transferencias ambiguas y vueltas completas compra/venta. Las demás transacciones permanecen en Watched Traders. No se inventa su clasificación. BNB Copy Trading conserva su propio motor; sus datos no entrenan este modelo Solana.

La referencia de contexto es nuestra observación real después de detectar la compra. Los precios actuales no se presentan como el precio de entrada histórico del trader. No se necesita inferir cuántos SOL pagó para observar el comportamiento posterior del token. Las transacciones históricas sin contexto contemporáneo no crean ejemplos retrospectivos.

## Datos y prueba

1. Cada token aporta una única trayectoria por protocolo. Se capturan características completas, la transacción fuente cuando corresponde y precios posteriores durante unos 24,5 minutos. Nunca se copian los datos de entrenamiento de otra instalación automáticamente.
2. Antes de ajustar reglas se requieren al menos 120 trayectorias y 24 horas de observación. Se necesitan al menos 20 compras de wallets en el periodo inicial. El tamaño por sí solo no garantiza que haya suficientes operaciones.
3. Se ordena por tiempo, separando aproximadamente 60% entrenamiento, 20% validación y 20% prueba final. Se eliminan de las divisiones los periodos que cruzan fronteras y se añade un embargo temporal. Los tokens no pueden aparecer en dos grupos.
4. Se calculan hasta 25 candidatas con entrenamiento, se comparan tres finalistas en validación y se prueba una sola candidata en el grupo final. Alterar los resultados finales no modifica los parámetros elegidos.
5. Los ejemplos sin precio o con huecos permanecen en el dataset. Una entrada que dependiera de ellos queda sin precio de ejecución y bloquea la aprobación. También se exige cobertura de la regla de referencia. No se borran pérdidas potenciales porque el token dejó de cotizar.
6. El dataset completo queda congelado, con parámetros, reglas del experimento, recibos, muestras, divisiones y un hash de contenido. El periodo completo se retira de futuras pruebas; no se repite una prueba final para buscar un resultado mejor.

El muestreo máximo es de 250 tokens por grupo, distribuidos en el tiempo sin seleccionar según ganancia. Esto acota memoria y CPU. El export informa población, muestras seleccionadas y periodos excluidos. No representa todo el mercado Solana ni elimina los sesgos del proveedor y de las wallets elegidas.

## Ejecución y costes

La regla aprendida toma una decisión en la primera observación completa de cada token, una sola oportunidad por token y versión. Esa restricción se conserva en el scanner y en SQLite después de reiniciar. No se cambia la estrategia de posiciones ya abiertas.

Las pruebas históricas usan una orden de US$2, US$100 virtuales, hasta tres posiciones y 60% de reserva. Por lado se asume 0,30% de comisión, 1% de slippage, US$0,03 de red e impacto estimado según liquidez. El llenado usa una observación estrictamente posterior a la señal, con hipótesis de latencia de dos segundos y un máximo de 90 segundos entre observaciones. No son rutas históricas ejecutables: esos costes siguen siendo supuestos de investigación. El precio real de una ruta futura puede diferir mucho.

La caída calculada usa PnL cerrado y puede subestimar pérdidas mientras una posición sigue abierta. Los límites de confianza de la media usan una aproximación normal; son filtros exploratorios, no una garantía estadística de rentabilidad. El registro lo conserva como limitación, y las pruebas futuras son obligatorias.

## Después del ajuste

**NO SUPERÓ LA VALIDACIÓN** significa que el algoritmo ajustó parámetros pero no pasó todos los filtros. No equivale a una estrategia lista para usar dinero real.

**LISTA PARA PROBAR EN PAPER** habilita **Probar con US$100 virtuales**. Crea una sesión nueva vinculada a esa versión, con el ejecutor PAPER existente, cotizaciones actuales y registro de compras/ventas. No abre otra sesión si existen posiciones o una sesión activa. No activa ni modifica el presupuesto de copy trading. Las órdenes LIVE y SHADOW de versiones aprendidas quedan bloqueadas.

La prueba futura muestra operaciones cerradas, tokens, PnL y tiempo observado. Los filtros para revisión incluyen 50 operaciones, 30 tokens, siete días, resultados netos positivos, posiciones cerradas y cotizaciones registradas. Incluso cuando pasan, solo se indica que corresponde revisar la evidencia. Nunca se habilita LIVE ni se deposita, firma o transmite dinero automáticamente. Los US$100 reales requieren una decisión posterior del usuario y validación de ejecución.

## Validación de software

`npm test` verifica separación temporal y por token, costes, selección ciega al test, retención de huecos, recuperación, decoder y bloqueos de LIVE. Los mercados sintéticos de estas pruebas están exclusivamente en tests y no se insertan en producción. Un recibo real de Solana sin swap verifica que no se inventen compras.

`node scripts/verify-cloud-runtime.mjs . docs/evidence/training-runtime-verification.json` inicia API, supervisor y worker reales con SQLite aislado y conexiones externas bloqueadas. Comprueba un trabajo de entrenamiento durante la desconexión de SSE, autenticación y recuperación. No demuestra rentabilidad, cobertura de todas las rutas ni 24 horas de actividad en Render.

## Referencias del decoder

- [IDL oficial de PumpSwap](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json)
- [Estructura de transacciones Solana](https://solana.com/docs/rpc/json-structures)
- [Sincronización de WSOL](https://solana.com/docs/tokens/basics/sync-native)
- [Cierre de cuentas de tokens](https://solana.com/docs/tokens/basics/close-account)
