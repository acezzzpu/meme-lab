export const SOLANA_PUBLIC_RPC='https://solana-rpc.publicnode.com';

export function providerErrorMessage(error='') {
 const text=String(error);
 const wait=text.match(/retry_in_ms=(\d+)/);
 if(text.includes('PROVIDER_COOLDOWN'))return `Proveedor en espera${wait?' · reintento en unos '+Math.ceil(Number(wait[1])/1000)+' s':''}. ${text.includes('429')?'Límite de consultas (429).':'Falló o demoró la última respuesta.'}`;
 if(text.includes('STALE_USDC_PRICE_AFTER_QUOTE'))return 'El precio de USDC venció mientras se cotizaba. La operación no se registró; se evaluará con datos nuevos.';
 if(text.includes('PROVIDER_HTTP_403'))return 'Acceso rechazado (403). Este proveedor bloqueó la consulta desde el servidor. Probá otro RPC.';
 if(text.includes('PROVIDER_HTTP_401'))return 'Credencial rechazada (401). Revisá la URL y la clave del proveedor.';
 if(text.includes('429'))return 'Límite de consultas alcanzado (429). Esperá y volvé a probar, o cambiá de proveedor.';
 if(/timeout|timed out|aborted/i.test(text))return 'El proveedor no respondió a tiempo. El motor volverá a intentarlo; revisá qué fuente está fallando.';
 if(/CHAIN_(GENESIS|ID)_MISMATCH/.test(text))return 'El RPC corresponde a otra red. Usá un endpoint de la red seleccionada.';
 return text||'La conexión falló. Probá de nuevo o revisá la configuración.';
}
