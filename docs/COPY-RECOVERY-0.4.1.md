# Copy Trading BNB: corrección 0.4.1

El diagnóstico exportado el 10 de septiembre de 2026 a las 16:13:53 de Argentina contiene 12 intentos de compra PAPER, todos rechazados, ninguna posición y ningún movimiento del capital virtual. El latido tenía 1,6 segundos de antigüedad, mientras la última lectura de bloques llevaba 57 segundos: el proceso estaba activo pero el RPC se atrasaba. El único proveedor era HTTP público, sin WebSocket. No había evidencia suficiente para copiar ventas nativas BNB.

El resumen verificable, sin credenciales, está en `docs/evidence/copy-incident-2026-09-10.json`. Conserva el hash SHA-256 del archivo recibido. Los motivos exactos de las rutas y los controles GoPlus anteriores no estaban guardados; esta actualización no inventa ni reconstruye esos resultados.

## Qué cambia

- El ejecutor selecciona la primera cotización que cumple las condiciones de la operación. Comprueba impuestos, impacto, liquidez, comparación de precio, capital/gas y términos de una aprobación antes de elegir. Conserva las comprobaciones finales de plazo, modo y STOP antes de ejecutar. No promete el mejor precio de todos los proveedores.
- Las solicitudes de rutas más lentas se cancelan, incluidas las consultas RPC en cola. Un proveedor incompleto o una ruta SmartRouter incompatible no impide elegir una alternativa válida. No se amplían los 2.000 ms configurados en el target.
- Cada proveedor admite hasta cuatro solicitudes simultáneas; solo una tarea de recuperación/diagnóstico ocupa capacidad de background. Las entradas tienen prioridad y la recuperación histórica espera entre trabajos. Los timeouts y límites HTTP aplican backoff. Una respuesta que no admite `debug_traceTransaction` se recuerda diez minutos, sin declarar caída toda la red. Un timeout no equivale a método no soportado.
- El rechazo conserva controles de seguridad, cotizaciones recibidas y errores de cada adaptador. Errores repetidos de trabajos se agrupan durante 30 segundos en el feed; cada trabajo sigue conservando su último error y su reintento durable.
- El panel separa proceso activo, conexión y antigüedad de la lectura. Muestra la hora del trade on-chain y la hora en que lo registró el motor. Distingue recuperación histórica de señales vencidas.
- Las estadísticas conservan las últimas 300 muestras por etapa, independientes del tráfico de bloques. QUOTE cuenta cotizaciones recibidas, incluso si después se rechazan. En PAPER, SIGN/SUBMIT/CONFIRM permanecen vacíos por diseño.

## Lo que sigue bloqueado

SmartRouter requiere impuestos de compra y venta verificados en cero. Una ruta 0x con impacto desconocido no se utiliza. Las ventas nativas sin importe verificable y las ventas proporcionales sin saldo previo verificable siguen sin copiarse. LIVE conserva sus permisos, firmas, reconciliación, límites y validaciones previas.

El software no puede hacer que un RPC entregue métodos o estado que no proporciona. Para este target hace falta verificar un proveedor BNB mainnet con HTTP + WSS, suscripciones reales y `debug_traceTransaction` con `callTracer`, además del estado histórico necesario para las proporciones de venta. Un plan pago por sí solo no certifica esas capacidades ni garantiza el margen de 2 segundos.

## Verificación

`tests/copy-latency-recovery.test.mjs` prueba cotizaciones compatibles/incompatibles, cancelación, prioridades, backoff, conservación del diagnóstico, protección de aprobaciones, STOP y un ciclo de compra/venta PAPER. Son respuestas controladas de prueba, no operaciones de mercado ni resultados de rentabilidad.

`docs/evidence/copy-runtime-verification.json` registra API, supervisor y worker reales en un entorno aislado: continuidad sin SSE/navegador, recuperación tras matar el worker, conservación de posiciones virtuales y STOP después de reiniciar. `docs/evidence/copy-recovery-cloud-verification.json` también comprueba que el entrenamiento sigue trabajando sin navegador y conserva SQLite al reiniciar. Ninguna de esas pruebas accede a fondos o envía transacciones.

## Comprobar en Render

1. Esperar que el despliegue de esta actualización termine en **Deploy succeeded**.
2. Abrir la aplicación en Render y actualizar con Ctrl + F5. El módulo debe mostrar **Versión 0.4.1**. `/healthz` devuelve `release: 0.4.1-copy-recovery`.
3. Mantener PAPER. Comprobar que la última lectura tenga una antigüedad baja y sostenida, y que el proveedor no permanezca en ERROR/BACKOFF.
4. Abrir un rechazo nuevo para consultar `safety`, `quote_attempts` y `route_errors`. Los rechazos anteriores conservan únicamente la evidencia que tenían.
5. Registrar al menos compras y ventas PAPER completas, con cotizaciones y costes, antes de evaluar cualquier prueba con dinero real.

No se ha confirmado desde este entorno el despliegue de Render ni una compra/venta exitosa de este target con el proveedor real. La base de datos de Render y sus credenciales no fueron modificadas directamente.
