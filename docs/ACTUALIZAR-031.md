# MEME LAB 0.3.1 — corregir el atraso de Copy BNB

Esta actualización se aplica sobre MEME LAB 0.3.0, la versión que ya tiene Copy Trading. No es una instalación separada.

## Windows, paso a paso

1. En Copy Trading dejá seleccionado PAPER. En la consola negra donde corre MEME LAB, presioná **Ctrl+C** para detener el programa antes de cambiar archivos. Si Windows pregunta si querés terminar el proceso por lotes, confirmá.
2. Hacé una copia de seguridad de tu carpeta actual de MEME LAB mientras el programa está detenido.
3. Extraé `meme-lab-actualizacion-031.zip`. Abrí la carpeta extraída: adentro vas a ver `app`, `core`, `runtime`, `docs`, `tests`, `package.json` y `package-lock.json`.
4. Copiá **todo ese contenido** dentro de tu carpeta actual de MEME LAB, en el mismo lugar donde está `Iniciar-MEME-LAB.cmd`. Aceptá **Reemplazar los archivos en el destino**. No borres tu carpeta `.runtime` ni tu archivo `.env`: contienen tus datos y configuración. El ZIP no los incluye ni los reemplaza.
5. Hacé doble clic en `Iniciar-MEME-LAB.cmd`. Esperá a que termine de compilar y aparezca el mensaje de inicio del servidor. Dejá esa consola abierta.
6. Abrí `http://localhost:8787`, entrá en **Copy Trading** y recargá con **Ctrl+F5**. Debajo de los controles debe aparecer **Versión 0.3.1**. Si aparece STOPPED, tocá **START COPY**. Si ya está activo, no hace falta volver a iniciarlo.
7. Mirá **Bloque de red**, **Último bloque revisado** y **Historial por recuperar**. Dejá trabajar el motor unos minutos. El historial debería ir reduciéndose si el proveedor puede responder al ritmo necesario. La lectura actual puede avanzar mientras aún recupera historial.
8. Para enviar el resultado, en **Actividad y posiciones**, bajá hasta **Feed de Copy Trading** y tocá **Exportar diagnóstico**. Adjuntá ese JSON. No hace falta pegar `/api/lab/copy/state` en la barra de Chrome.

La consola debe quedar abierta y la PC encendida, sin suspensión. Podés cerrar Chrome. Este paquete no convierte la PC en un VPS ni instala un servicio automático de Windows.

## Qué se corrigió

- Lectura de bloques nuevos y recuperación histórica independientes, con un máximo de dos lecturas de bloques simultáneas. Las escrituras se ordenan para conservar un cursor continuo.
- El análisis histórico tiene su propio trabajo de fondo y no ocupa el ejecutor de señales actuales. Las firmas y los envíos de nuestra wallet siguen serializados.
- Una observación HTTP y otra WebSocket del mismo bloque no obligan a descargarlo dos veces. Una contradicción de hashes sigue deteniendo la copia para reconciliación.
- Los trabajos de la versión anterior se recuperan; el cursor nunca salta bloques sin revisar. Los eventos antiguos o vencidos quedan como historial y no disparan compras retrospectivas.
- Los trabajos del target y la marca de bloque revisado se guardan en una única transacción de SQLite. Un fallo no puede marcar como completo un bloque cuyos trabajos no se guardaron.
- El panel distingue la cabeza de la red, el último bloque revisado, el historial pendiente y la salud de la conexión. Las horas muestran hora, minutos, segundos y milisegundos.
- Exportar diagnóstico incluye estado, cola pendiente, últimos RPC y errores, además de la evidencia de operaciones. No incluye claves privadas ni las rutas secretas de los proveedores.

## Lo que el diagnóstico recibido demuestra

El RPC respondió en aproximadamente 183–220 ms en las últimas ocho consultas del archivo. Aun así, el motor estaba 457 bloques detrás, con 40 trabajos pendientes. Había un cuello de botella interno; esperar o comprar otro proveedor por sí solo no lo corregía.

Registró dos salidas de tokens UPONLY, pero no pudo verificar el importe de BNB de esas transacciones: `QUOTE_AMOUNT_NOT_VERIFIABLE`. No hay ninguna copia ejecutada en ese archivo. Corregir la cola no convierte automáticamente esos movimientos en swaps que el sistema pueda copiar.

Para operaciones que devuelven BNB nativo y no dejan una transferencia ERC-20 verificable hacia el trader, el decodificador necesita evidencia de `debug_traceTransaction` compatible con `callTracer`. Si falta, el registro conserva UNKNOWN y ahora muestra el motivo de esa consulta. Este parche no inventa cuánto recibió ni habilita LIVE por ese motivo.

## Validación y límites

Resultado de esta actualización: **130/130 pruebas**, TypeScript y compilación standalone correctos; integración de servidor/supervisor/reinicio **PASSED**.

Se verifican con pruebas locales la cola de 457 bloques, deduplicación, prioridades, fallos de persistencia, hashes contradictorios, recuperación y aislamiento entre lectura/análisis histórico y actual. Son respuestas RPC controladas para reproducir errores, no una medición nueva de latencia en mainnet.

La integración ejecuta el servidor, supervisor y worker reales en Linux con una base temporal: cierra SSE, observa avances, interrumpe el worker identificado y comprueba la recuperación de posiciones y saldos virtuales. No envía transacciones ni usa dinero real. El instalador no se ejecutó en Windows en este entorno.

La latencia real con tu conexión y proveedor se comprueba después de actualizar tu PC. No hay una prueba de compra/venta financiada ni una validación de funcionamiento continuo durante 24 horas en esta entrega.
