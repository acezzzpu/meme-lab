# Pendientes tras la transformación persistente

El motor, workers, WSS/SSE, cola, control, recuperación y dashboard están implementados. Consultar COMPLETION.md para evidencia ejecutada; no inferir que toda función fue validada en producción.

- Aprovisionar VPS/PC del usuario y RPC autenticado; validar Docker/Caddy/HTTPS allí y realizar soak de 24–72 horas.
- Completar prueba financiada y contabilidad on-chain de round trip antes de LIVE AUTO.
- Cartera SHADOW completa, comparación de fills y salidas parciales TP1/TP2 configurables.
- Cobertura adicional de AMMs/pools; rollback de reorgs y métricas explícitas de lag/retención del proveedor.
- Calibración de patrones, bot/humano, PnL completo de traders, entrenamiento/validación walk-forward.
- Backups remotos programados, alertas fuera de la web, restore ensayado sobre infraestructura final.
- Importador de sesiones/datasets existentes y migración asistida D1 → servidor; no mezclar balances automáticamente.
- Ensayo prolongado de carga, almacenamiento y cuotas; redundancia distribuida si el uso lo requiere.
