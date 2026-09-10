# MEME LAB · despliegue 24/7

## Qué contratar

Estimación inicial para un operador, dos redes y 10–30 wallets filtradas: **2 vCPU, 4 GiB RAM, 80 GiB SSD**, Ubuntu 24.04 y salida HTTPS/WSS. Es una estimación, no un benchmark ni cobertura de todos los swaps Solana. Escalar a 4 vCPU/8 GiB cuando crezcan cola/análisis. No hace falta nodo completo, Redis ni PostgreSQL para esta instancia única; SQLite WAL vive en volumen local, nunca NFS.

Precios públicos consultados el 10/09/2026, USD antes de impuestos/excesos:

| Servicio | Selección | Precio |
|---|---|---:|
| VPS | DigitalOcean Basic Regular 2 vCPU / 4 GiB / 80 GiB | 24/mes |
| Backup VPS diario | +30% del Droplet | 7,20/mes |
| Solana RPC | Helius Developer, 10 M créditos, 50 RPS, WebSockets según plan | 49/mes |
| Robinhood RPC | Alchemy Free, hasta 30 M CU/mes y 25 RPS | 0 dentro de cuota |
| Dominio | .com estándar no premium en Porkbun | 11,08/año |

**Total orientativo: USD 80,20/mes + dominio**, manteniendo Alchemy dentro de cuota. PAYG Alchemy publica USD 0,45/millón CU en el primer tramo: no es tarifa fija. Helius Developer es endpoint autenticado compartido, no nodo dedicado. Jupiter puede requerir una clave/cuota adicional según uso. Medir consumo antes de ampliar universo; este presupuesto no promete capacidad ilimitada.

Fuentes: [DigitalOcean](https://www.digitalocean.com/pricing/droplets), [backups](https://docs.digitalocean.com/products/backups/details/pricing/), [Helius](https://www.helius.dev/pricing), [Alchemy](https://www.alchemy.com/pricing), [Porkbun](https://porkbun.com/products/domains).

Alternativa PC: Node.js 24.19+, 4 GiB libres, SSD y suspensión desactivada. Cerrar Chrome está permitido; apagar/suspender PC o cerrar consola detiene esa instalación. El script Windows arranca el proyecto, pero no instala un servicio Windows. Docker Desktop puede configurarse para inicio automático del equipo.

## Instalar VPS con HTTPS

1. Crear Ubuntu 24.04, SSH con clave y firewall para 22 (administración), 80 y 443. No abrir 8787 al exterior.
2. Instalar Docker Engine y Compose plugin desde [la guía oficial](https://docs.docker.com/engine/install/ubuntu/). Habilitar Docker al inicio del host.
3. Descomprimir el paquete en `/opt/meme-lab`. Trabajar en la carpeta que contiene `compose.production.yaml`.
4. Crear registro DNS A `bot` hacia la IPv4 del VPS. AAAA solo con IPv6 configurado.
5. Copiar el ejemplo y completar dominio/email:

```bash
cp .env.production.example .env.production
# Editar DOMAIN=bot.tudominio.com y CONTACT_EMAIL.
docker compose --env-file .env.production -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml up -d --build
docker compose --env-file .env.production -f compose.production.yaml exec meme-lab cat /data/admin-token
```

Abrir `https://bot.tudominio.com`, ingresar el token y configurar fuentes/estrategia/PAPER. Caddy gestiona certificados y SSE sin buffering. Volúmenes conservan datos/certificados; `restart: unless-stopped` reinicia el servicio. **No usar `down -v`: borra volúmenes.**

Configurar en Settings → Networks:

- Solana: HTTPS y WSS exactos del dashboard Helius. PublicNode gratuito sirve para probar; no sustituye una cuota contratada.
- Robinhood: `https://robinhood-mainnet.g.alchemy.com/v2/KEY` y `wss://robinhood-mainnet.g.alchemy.com/v2/KEY`, según [documentación oficial](https://docs.robinhood.com/chain/connecting/). Verificar chain ID 4663. La UI diferencia RPC de WSS.
- El RPC HTTP oficial Robinhood no se convierte automáticamente en WSS si no hay endpoint confirmado. Puede haber monitoreo RPC con WSS NOT CONFIGURED.

**No se contrató ni desplegó un VPS externo en esta entrega.** No hay Docker ni dominio del usuario disponibles en el entorno de construcción: los manifiestos están preparados, pero contenedores/certificados deben comprobarse al desplegar.

## Usar la web privada existente como panel

La opción más simple es abrir la URL HTTPS del VPS. Para usar la web ya publicada:

1. Generar una clave aleatoria local y ponerla en `REMOTE_API_TOKEN` de `.env.production`; recrear contenedor.
2. Configurar el alojamiento web con `REMOTE_ENGINE_URL=https://bot.tudominio.com` y secreto `REMOTE_ENGINE_TOKEN` con el mismo valor.
3. Aplicar/publicar configuración. La web autentica al propietario y la API reenvía al servidor; el navegador nunca recibe el secreto.

No pegar claves en chat. Usa solo la base del VPS, no mezcla saldos D1 antiguos. La conexión no se activó porque todavía no existe ese endpoint del usuario.

## Comprobar que sigue trabajando sin Chrome

Anotar uptime, slot/bloque y último evento. Cerrar todas las ventanas durante 10 minutos. Volver a la misma URL: deben aparecer observaciones/decisiones con timestamps del intervalo cerrado y bloques posteriores. Puede haber cero trades si no se cumplen reglas.

```bash
docker compose --env-file .env.production -f compose.production.yaml ps
docker compose --env-file .env.production -f compose.production.yaml logs --tail=80 meme-lab
docker compose --env-file .env.production -f compose.production.yaml exec meme-lab node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>r.text()).then(console.log)"
```

Los eventos detallados están en base y Dashboard; stdout contiene arranques/errores de proceso. Probar reinicio inicialmente en PAPER y comprobar misma sesión, saldo e inventario. `npm run test:engine` realiza un ensayo aislado de desconexión, caída de worker y reinicio total; no toca la base de operación.

## Backup y actualización

```bash
docker compose --env-file .env.production -f compose.production.yaml exec meme-lab node scripts/backup.mjs /backups/backup-fecha
```

Copiar el backup fuera del VPS a un destino privado. El backup del proveedor protege la máquina y el comando hace copia consistente de la aplicación. La programación/copia externa requiere configuración del operador. Conservar la clave de cifrado junto al backup protegido.

Antes de actualizar, pausar entradas y respaldar. Reemplazar fuentes y ejecutar `up -d --build` conservando volúmenes. Migraciones aditivas e idempotentes, sin reset. Restaurar según README con servicio detenido; reconciliar wallet antes de reactivar dinero real.

No hay redundancia de hosts, SLA propio, prueba de 24 horas, failover automático de proveedor durante una orden ni rollback completo de reorgs. Watchdog no resuelve una cuota agotada ni disco lleno. Monitorear latencia y cola antes de aumentar cobertura/capital.
