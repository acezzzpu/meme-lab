# Recuperación de la captura de entrenamiento

Cuando dos trabajos históricos ocupaban los primeros lugares de un motor con
tres tareas simultáneas, el lugar reservado solo admitía conciliación y salidas.
Una captura de precios de entrenamiento pendiente podía quedar esperando aunque
ese lugar estuviera libre. Además, las transacciones históricas tenían prioridad
sobre consultar nuevas firmas de wallets, comprobar proveedores y entrenar.

En modo OBSERVE, con trading desactivado, el planificador ahora permite
`TRAINING_MARKET` en el lugar reservado y atiende su captura antes del scanner.
PAPER y LIVE conservan la reserva exclusiva para conciliación y salidas. La consulta
de wallets, salud del proveedor y entrenamiento preceden al backlog de
transacciones; los trabajos históricos siguen ejecutándose en los demás lugares.
Se conservan los límites de concurrencia, los reintentos y la persistencia.

El panel aclara que el contador del próximo dataset incluye registros incompletos
y muestra la fecha del último problema de precios con acceso a las conexiones.
No se rellenan huecos históricos ni se modifica el máximo de 90 segundos entre
observaciones. Tampoco cambia la cobertura del decoder ni se habilita dinero real.

## Evidencia y límites

- Se reprodujeron con SQLite aislado cuatro casos que fallaban con la política
  anterior: captura bloqueada en el lugar reservado, captura después de salidas,
  scanner antes de captura y backlog antes de consultas/entrenamiento.
- Los casos del nuevo test comprueban recuperación, prioridad de salidas y
  reserva de capacidad sin enviar consultas externas.
- `/healthz` de Render respondió `0.4.1-copy-recovery` y `RUNNING` antes del cambio.
  Eso acredita versión y proceso activo, no precios frescos ni entrenamiento sano.
- Esta reparación resuelve un bloqueo reproducible del planificador. No demuestra
  que haya causado todos los timeouts de producción ni que un proveedor externo
  se haya recuperado. Hace falta un diagnóstico nuevo del servidor tras desplegar.

Para comprobar producción, revisar las horas de `TRAINING_MARKET`, los motivos de
exclusión, los últimos éxitos/errores del proveedor y las compras compatibles de
cada wallet. Mantener separados los datos nuevos de las trayectorias que ya
quedaron incompletas.
