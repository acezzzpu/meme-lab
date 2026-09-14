// Keyset pagination plus byte chunks: even one RPC_USAGE row can be megabytes.
export async function eventHistory(store,{before=Number.MAX_SAFE_INTEGER,limit=25,id=null,offset=0,source='events'}={}){
 const tables={events:'engine_events',actions:'copy_actions',targets:'copy_events',profiles:'copy_latency_profiles'};const table=tables[source];if(!table)throw Error('INVALID_HISTORY_SOURCE');
 if(!Number.isSafeInteger(before)||before<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('INVALID_PAGE');
 if(id!==null){if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(offset)||offset<0)throw Error('INVALID_CURSOR');const row=await store.get(`SELECT rowid id,length(CAST(data AS BLOB)) bytes,hex(substr(CAST(data AS BLOB),?,32768)) chunk FROM ${table} WHERE rowid=?`,offset+1,id);return row?{id:row.id,bytes:row.bytes,encoding:'hex-utf8',chunk:row.chunk,next_offset:offset+32768<row.bytes?offset+32768:null}:null;}
 if(source!=='events'){const key=source==='profiles'?'event_id':'id';const rows=await store.all(`SELECT rowid id,${key} record_id,length(CAST(data AS BLOB)) data_bytes FROM ${table} WHERE rowid<? ORDER BY rowid DESC LIMIT ?`,before,limit);return {source,rows,next_before:rows.length===limit?rows.at(-1).id:null};}
 const rows=await store.all('SELECT id,at,kind,message,chain,entity_id,length(CAST(data AS BLOB)) data_bytes FROM engine_events WHERE id<? ORDER BY id DESC LIMIT ?',before,limit);return {rows,next_before:rows.length===limit?rows.at(-1).id:null};
}
