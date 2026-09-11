import {measuredQuantiles} from '../../core/copy/latency-profile.mjs';
// Counts actual wire traffic, not loop iterations or canceled queue entries.
// Subscription notifications are separate from HTTP request counts: they can be
// billable even when the client discards every unrelated transaction.
export class RpcTelemetry {
 constructor({now=Date.now,saved=null}={}){this.now=now;this.started=now();this.groups=new Map();this.seconds=new Map();this.daily=saved?.daily??{};this.cacheHits=0;this.cacheMisses=0;this.suppressed={};}
 group(provider,method,pipeline,transport){const key=[provider,method,pipeline,transport].join('|');if(!this.groups.has(key))this.groups.set(key,{provider,method,pipeline,transport,requests:0,notifications:0,bytes:0,errors:0,rate_limits:0,timeouts:0,cancelled:0});return this.groups.get(key);}
 add(provider,method,{pipeline='LIVE_TARGET_PIPELINE',transport='HTTP',notification=false,bytes=0,units=0}={}){
  const at=this.now(),g=this.group(provider,method,pipeline,transport),kind=notification?'notifications':'requests';g[kind]++;g.bytes+=bytes;
  const second=Math.floor(at/1000);let b=this.seconds.get(second);if(!b){b={};this.seconds.set(second,b);}const row=b[provider]??={requests:0,notifications:0};row[kind]++;
  const day=new Date(at).toISOString().slice(0,10);let d=this.daily[provider];if(d?.day!==day)d=this.daily[provider]={day,requests:0,notifications:0,estimated_units:0};d[kind]++;d.estimated_units+=units;
  if(this.seconds.size>3601)for(const s of this.seconds.keys()){if(s<second-3600)this.seconds.delete(s);else break;}
 }
 outcome(provider,method,{pipeline='LIVE_TARGET_PIPELINE',transport='HTTP',error='',cancelled=false,status=0}={}){if(!error)return;const g=this.group(provider,method,pipeline,transport);if(cancelled){g.cancelled++;return;}g.errors++;if(status===429||/429|quota|daily.*limit|rate.?limit|request limit|maximum API usage|ran out of cu/i.test(error))g.rate_limits++;if(/timeout|timed out|TimeoutError/i.test(error))g.timeouts++;}
 cache(hit){hit?this.cacheHits++:this.cacheMisses++;}
 timing(provider,method,{pipeline='LIVE_TARGET_PIPELINE',duration_ms,queue_ms,status,error=null}){
  const g=this.group(provider,method,pipeline,'HTTP');g.timing_count=(g.timing_count??0)+1;g.recent_timings??=[];
  g.recent_timings.push({at:this.now(),duration_ms,queue_ms,status,error});if(g.recent_timings.length>256)g.recent_timings.shift();
 }
 suppress(reason){this.suppressed[reason]=(this.suppressed[reason]??0)+1;}
 snapshot(providers=[]){
  const now=this.now(),second=Math.floor(now/1000),rows=[...this.groups.values()].map(g=>({...g,latency:g.recent_timings?{window:'LAST_256_SENT_HTTP_REQUESTS_PER_METHOD',all:measuredQuantiles(g.recent_timings.map(t=>t.duration_ms)),successful:measuredQuantiles(g.recent_timings.filter(t=>t.status==='OK').map(t=>t.duration_ms)),queue:measuredQuantiles(g.recent_timings.map(t=>t.queue_ms))}:null}));
  const ps=providers.map(p=>{const groups=rows.filter(g=>g.provider===p.id);const r={provider:p.id,requests:0,notifications:0,bytes:0,errors:0,rate_limits:0,timeouts:0,cancelled:0,requests_min:0,requests_hour:0,notifications_min:0,notifications_hour:0};for(const g of groups)for(const k of ['requests','notifications','bytes','errors','rate_limits','timeouts','cancelled'])r[k]+=g[k];for(const [s,b] of this.seconds){const v=b[p.id];if(!v||s<=second-3600)continue;r.requests_hour+=v.requests;r.notifications_hour+=v.notifications;if(s>second-60){r.requests_min+=v.requests;r.notifications_min+=v.notifications;}}
   const day=this.daily[p.id],used=day?.day===new Date(now).toISOString().slice(0,10)?day.estimated_units:0;
   return {...r,daily_requests:day?.day===new Date(now).toISOString().slice(0,10)?day.requests:0,daily_units_estimated:used,known_daily_limit:p.daily_credit_limit??null,quota_remaining_reported:null,quota_source:'LOCAL_USAGE_ESTIMATE_NOT_PROVIDER_BILLING',backfill_paused:!!p.daily_credit_limit&&used>=p.daily_credit_limit*.8};});
  return {at:now,since:this.started,window_precision:'ROLLING_SECONDS',providers:ps,by_method:rows,failover:this.failover??null,cache:{hits:this.cacheHits,misses:this.cacheMisses,hit_rate:this.cacheHits+this.cacheMisses?this.cacheHits/(this.cacheHits+this.cacheMisses):null},suppressed:{...this.suppressed},daily:this.daily};
 }
}
