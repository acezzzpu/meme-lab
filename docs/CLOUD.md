# MEME LAB en la nube

El despliegue preparado ejecuta la API, el supervisor y sus workers en un servicio Node permanente. Chrome muestra el panel; la PC del operador puede apagarse. La configuración está en `render.yaml`.

## Estado de esta entrega

La configuración y el proceso local están probados. **Todavía no hay un servicio Render del usuario creado o conectado.** No se contrató alojamiento, no se cargaron fondos y no se ejecutó ninguna operación LIVE. El repositorio actual de Sites conserva el código; para el despliegue automático de Render falta conectarlo a un repositorio privado admitido por Render y a la cuenta de alojamiento del usuario.

## Despliegue desde el navegador

1. Conectar la cuenta de Render. Crear un repositorio privado del proyecto en GitHub y autorizar a Render a leerlo. El código contiene `render.yaml`; no copiar credenciales ni datos de operación al repositorio.
2. En Render, abrir **New → Blueprint**, elegir ese repositorio y revisar el servicio `meme-lab-engine`.
3. La configuración inicial usa **1 CPU, 2 GB RAM, 10 GB de disco**, región Virginia y una sola instancia. Revisar el importe que muestra Render antes de crear los recursos. El RPC de BNB y su cuota se contratan por separado cuando sean necesarios. Estos recursos son un punto de partida para cobertura acotada, no un benchmark de latencia. Si se activa todo el scanner o crecen cola/memoria, aumentar a 2 CPU/4 GB.
4. Confirmar el despliegue. Render instala dependencias, ejecuta las pruebas y compila el panel antes de iniciar el servidor. No usar el plan gratuito: esta configuración necesita proceso permanente y disco persistente.
5. En el servicio, abrir **Environment**, mostrar `ADMIN_TOKEN` y copiarlo. Abrir la URL HTTPS `onrender.com` que asigne Render y pegar ese token en el acceso a MEME LAB. No compartirlo en chats.
6. En **Copy Trading → Latencia y conexiones**, configurar HTTP y WSS de BNB del mismo proveedor. Verificar chain ID 56, avance de bloques y capacidad de trace/estado histórico. Configurar PAPER y tocar **START COPY** una vez.

El dominio HTTPS del proveedor alcanza para empezar. Un dominio propio es opcional. El proceso inicia detenido en una base nueva; una instalación configurada recupera el estado persistente al reiniciar.

## Actualizaciones sin descargas en la PC

Render sigue la rama vinculada. Cuando se publica una versión revisada, ejecuta las pruebas y el build; si fallan no reemplaza la versión desplegada. Después reinicia el proceso conservando el disco. La PC no participa. Hay una interrupción breve durante el cambio: este despliegue de una sola instancia no ofrece continuidad sin cortes.

Las sesiones web se invalidan al reiniciar: volver a ingresar con el mismo `ADMIN_TOKEN`. PAPER/observación recuperan su estado. Por diseño, LIVE queda pausado o deshabilitado al reiniciar y requiere revisar la reconciliación antes de reactivarlo.

## Datos y migración

`DATA_DIR` apunta exactamente al disco persistente. Allí quedan SQLite, su WAL y la clave de cifrado. El build ocurre fuera de ese disco. No regenerar `master-key` si se conserva una base cifrada, ni borrar/recrear el disco para actualizar código.

El export JSON de diagnóstico no es una copia restaurable de toda la instalación. La base que actualmente corre en Windows no se transfiere por instalar el servicio. Antes de retirar esa instancia, detenerla y crear su backup consistente; restaurar la base y su clave correspondiente con ambos motores detenidos. Este paso inicial es necesario si se quiere conservar su historial, configuración y posiciones. No poner backup, wallet ni claves en GitHub.

Para un backup consistente del servidor se puede usar **Shell** de Render, sin instalar nada en la PC:

```bash
node scripts/backup.mjs /opt/render/project/src/.runtime/backups/manual
```

Ese backup dentro del mismo disco no protege frente a pérdida del disco: conservar otra copia privada fuera del servicio. Los snapshots del proveedor no sustituyen comprobar la restauración de la aplicación. Configurar y verificar esa copia externa antes de LIVE.

## Comprobación en la nube

1. Verificar `Servidor en la nube` en **Settings → System health**, health HTTP y el heartbeat.
2. Registrar la hora, el bloque de red y el último bloque revisado en Copy Trading.
3. Cerrar Chrome y apagar la PC durante al menos diez minutos.
4. Desde otra PC o teléfono abrir la URL HTTPS del servidor. Comprobar eventos con fechas dentro del intervalo, avance de bloques y ausencia de una nueva sesión del motor causada por cerrar Chrome. Cero operaciones puede ser correcto si no hay una señal elegible.
5. Inicialmente en PAPER, reiniciar el servicio desde Render y verificar saldo, posiciones, historial y estado recuperado.

`/healthz` detecta caída del proceso general; no acredita salud de cada RPC ni del decodificador. Revisar también latencia, cuota, backoff, profundidad de cola y disco. Este paquete no acredita 24 horas de disponibilidad ni velocidad real desde Render hasta que se despliegue y mida allí.

Fuentes verificadas el 10/09/2026: [Blueprint](https://render.com/docs/blueprint-spec), [discos](https://render.com/docs/disks), [versión Node](https://render.com/docs/node-version), [actualizaciones](https://render.com/docs/deploys), [health checks](https://render.com/docs/health-checks), [precio vigente al contratar](https://render.com/pricing).
