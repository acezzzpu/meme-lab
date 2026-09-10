export const copyTime=n=>n&&Number.isFinite(Number(n))?new Date(Number(n)).toLocaleTimeString('es-AR',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3}):'—';

export function copyHealth(health=[],runtime,enabled=true,now=Date.now()){
 enabled=enabled&&runtime?.status!=='STOPPED';
 const fresh=health.filter(h=>now-h.updated_at>=-2000&&now-h.updated_at<15000);
 const connected=fresh.find(h=>h.status==='CONNECTED'),http=fresh.find(h=>h.status==='RPC_ONLY');
 const processFresh=!!runtime?.at&&now-runtime.at>=-2000&&now-runtime.at<15000;
 const readFresh=!!runtime?.last_scanned_at&&now-runtime.last_scanned_at>=-2000&&now-runtime.last_scanned_at<15000;
 return {process:!enabled?'STOPPED':processFresh?'ACTIVO':'SIN LATIDO RECIENTE',network:!enabled?'DETENIDA':connected?'WEBSOCKET':http?'RPC HTTP':fresh.some(h=>h.status==='BACKOFF')?'BACKOFF':fresh.some(h=>h.status==='ERROR')?'ERROR':'SIN DATOS RECIENTES',connected:enabled&&!!(connected||http),processFresh,readFresh,read_age_ms:runtime?.last_scanned_at?Math.max(0,now-runtime.last_scanned_at):null};
}
export function copyErrorMessage(error){
 const messages={SIGNAL_EXPIRED:'Llegó fuera del tiempo permitido para copiar.',ROUTE_QUOTE_TIMEOUT:'No llegó una cotización compatible antes del límite.',NO_EXECUTABLE_ROUTE:'Ninguna ruta pasó las comprobaciones. Abrí el registro para ver los motivos.',SMART_FEE_ON_TRANSFER_OR_UNKNOWN_UNSUPPORTED:'SmartRouter requiere impuestos de compra y venta verificados en cero.',TOKEN_SAFETY_FAILED:'Un control del token falló. Abrí el registro para ver cuál.',TOKEN_SAFETY_UNKNOWN:'Faltan datos para completar los controles del token.',IMPACT_UNKNOWN:'La ruta no informa un impacto verificable.'};
 return messages[error]??error;
}
export function historyLabel(data){return data?.history_reason?.startsWith('EXPIRED')?'SEÑAL VENCIDA · no se copia':data?.history?'RECUPERADO · no se copia':null;}
