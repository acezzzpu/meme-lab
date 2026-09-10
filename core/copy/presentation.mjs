export const copyTime=n=>n&&Number.isFinite(Number(n))?new Date(Number(n)).toLocaleTimeString('es-AR',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3}):'—';
