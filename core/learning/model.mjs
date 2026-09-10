import {baseline,evaluate} from '../strategy.mjs';

// This is fitted rule search, not a pretrained model. Every fitted parameter and
// out-of-sample result is retained by the pipeline that calls these pure functions.
export const PROTOCOL = Object.freeze({
  version:'wallet-rules-v1', horizon_ms:20*60000, latency_ms:2000,
  max_gap_ms:90000, fee_bps:30, slippage_bps:100, network_fee_cents:3,
  order_cents:200, capital_cents:10000, reserve_pct:60, max_positions:3,
  max_impact_pct:2, daily_loss_cents:1000, min_samples:120,
  min_wallet_train:20, min_train_trades:20, min_validation_trades:10,
  min_test_trades:10, min_market_test_trades:10, min_span_ms:86400000,
});
const finite = n => typeof n==='number' && Number.isFinite(n);
export function featureError(s) {
  if(!s || !finite(s.received_at) || !finite(s.observed_at) || s.observed_at>s.received_at) return 'INVALID_TIMESTAMPS';
  for(const k of ['price','liquidity','market_cap']) if(!finite(s[k])||s[k]<=0)return 'MISSING_'+k.toUpperCase();
  for(const k of ['volume_5m','buys_5m','sells_5m'])if(!finite(s[k])||s[k]<0)return 'MISSING_'+k.toUpperCase();
  if(!finite(s.change_5m))return 'MISSING_MOMENTUM';
  if(!finite(s.pool_created)||s.pool_created<=0||s.pool_created>s.received_at)return 'MISSING_POOL_AGE';
  return null;
}
function quantile(values,q){const a=values.filter(finite).sort((a,b)=>a-b);return a.length?a[Math.floor((a.length-1)*q)]:null;}
function rounded(n){return Math.round(n*10000)/10000;}
export function candidatesFrom(train,protocol=PROTOCOL) {
  const wallet=train.filter(s=>s.source==='WALLET').map(s=>s.features);
  if(wallet.length<protocol.min_wallet_train)return [];
  const q=(key,p)=>quantile(wallet.map(s=>key==='ratio'?s.buys_5m/Math.max(1,s.sells_5m):key==='age'?(s.received_at-s.pool_created)/60000:s[key]),p);
  const result=[{...baseline}];
  for(const percentile of [.2,.4,.6])for(const stop of [10,15])for(const profit of [20,35])for(const hold of [10,20]) {
    result.push({chain:'solana',min_liquidity:Math.max(15000,rounded(q('liquidity',percentile))),
      min_market_cap:Math.max(10000,rounded(q('market_cap',.1))),max_market_cap:Math.max(10000,rounded(q('market_cap',.9))),
      max_age_minutes:Math.max(1,Math.min(120,rounded(q('age',.9)))),
      min_volume_5m:Math.max(0,rounded(q('volume_5m',percentile))),min_buy_sell_ratio:Math.max(.1,rounded(q('ratio',percentile))),
      min_change_5m:rounded(q('change_5m',percentile)),stop_loss_pct:stop,take_profit_pct:profit,trailing_pct:12,max_hold_minutes:hold});
  }
  return [...new Map(result.map(p=>[JSON.stringify(p),p])).values()];
}
export function splitSamples(samples,protocol=PROTOCOL) {
  // One episode per token, selected in observation order. Later appearances can
  // never cross into validation/test. Labels crossing a boundary are purged.
  const unique=[...new Map([...samples].sort((a,b)=>b.anchor_at-a.anchor_at).map(s=>[s.token_id,s])).values()].sort((a,b)=>a.anchor_at-b.anchor_at);
  if(unique.length<protocol.min_samples)return {train:[],validation:[],test:[],excluded:unique.length,reason:'INSUFFICIENT_SAMPLES'};
  const validationAt=unique[Math.floor(unique.length*.6)].anchor_at,testAt=unique[Math.floor(unique.length*.8)].anchor_at;
  const embargo=protocol.horizon_ms+protocol.latency_ms+protocol.max_gap_ms;
  const train=unique.filter(s=>s.anchor_at<validationAt&&s.end_at<validationAt-embargo);
  const validation=unique.filter(s=>s.anchor_at>=validationAt&&s.anchor_at<testAt&&s.end_at<testAt-embargo);
  const test=unique.filter(s=>s.anchor_at>=testAt);
  return {train,validation,test,validation_at:validationAt,test_at:testAt,embargo_ms:embargo,excluded:unique.length-train.length-validation.length-test.length};
}
function usable(p){return p&&finite(p.price)&&p.price>0&&finite(p.liquidity)&&p.liquidity>0&&finite(p.received_at)&&finite(p.observed_at)&&p.observed_at<=p.received_at;}
export function episodeTrade(sample,params,protocol=PROTOCOL) {
  const s=sample.features;
  if(featureError(s)||s.received_at!==sample.anchor_at)return {state:'UNUSABLE',reason:'INVALID_FEATURES'};
  if(evaluate(s,params,{chain:'solana'},{created_at:s.pool_created},sample.anchor_at).decision!=='SIGNAL')return {state:'REJECTED'};
  if(sample.state==='EXCLUDED')return {state:'UNPRICED',reason:sample.reason??'INCOMPLETE_OUTCOME'};
  const points=sample.trajectory.filter(p=>p.received_at>sample.anchor_at&&p.received_at<=sample.end_at).sort((a,b)=>a.received_at-b.received_at);
  const entry=points.find(p=>p.received_at>=sample.anchor_at+protocol.latency_ms);
  if(!usable(entry)||entry.received_at-sample.anchor_at>protocol.max_gap_ms)return {state:'UNPRICED',reason:'NO_ENTRY_PRICE'};
  const amount=protocol.order_cents/100,impact=amount/(entry.liquidity/2),costs=(protocol.fee_bps+protocol.slippage_bps)/10000;
  if(entry.liquidity<params.min_liquidity||impact>protocol.max_impact_pct/100)return {state:'REJECTED'};
  const buyPrice=entry.price*(1+costs+impact),quantity=amount/buyPrice,cost=protocol.order_cents+protocol.network_fee_cents;
  let high=buyPrice,previous=entry.received_at,pending=null;
  for(const p of points.filter(p=>p.received_at>entry.received_at)) {
    if(!usable(p)||p.received_at-previous>protocol.max_gap_ms)return {state:'UNPRICED',reason:'PRICE_GAP'};
    previous=p.received_at;high=Math.max(high,p.price);
    if(pending&&p.received_at>=pending.at+protocol.latency_ms){
      const sellImpact=quantity*p.price/(p.liquidity/2);
      if(sellImpact>protocol.max_impact_pct/100)return {state:'UNPRICED',reason:'EXIT_IMPACT'};
      const proceeds=Math.max(0,Math.floor(quantity*p.price*(1-costs-sellImpact)*100)-protocol.network_fee_cents);
      return {state:'CLOSED',token_id:sample.token_id,sample_id:sample.id,source:sample.source,entry_at:entry.received_at,exit_at:p.received_at,
        pnl_cents:proceeds-cost,cost_cents:cost,reason:pending.reason,entry_snapshot:entry.id,exit_snapshot:p.id};
    }
    const change=(p.price/buyPrice-1)*100;
    const reason=change<=-params.stop_loss_pct?'STOP_LOSS':change>=params.take_profit_pct?'TAKE_PROFIT':p.price<high*(1-params.trailing_pct/100)?'TRAILING':p.received_at-entry.received_at>=params.max_hold_minutes*60000?'TIME_EXIT':null;
    if(reason&&!pending)pending={at:p.received_at,reason};
  }
  return {state:'UNPRICED',reason:'NO_EXIT_PRICE'};
}
export function metrics(trades,protocol=PROTOCOL) {
  let cash=protocol.capital_cents,peak=cash,dd=0;const ordered=[...trades].sort((a,b)=>a.exit_at-b.exit_at);
  for(const t of ordered){cash+=t.pnl_cents;peak=Math.max(peak,cash);dd=Math.max(dd,(peak-cash)/peak);}
  const n=trades.length,values=trades.map(t=>t.pnl_cents),pnl=values.reduce((a,b)=>a+b,0),mean=n?pnl/n:0;
  const variance=n>1?values.reduce((a,b)=>a+(b-mean)**2,0)/(n-1):0;
  const gains=values.filter(x=>x>0).reduce((a,b)=>a+b,0),losses=-values.filter(x=>x<0).reduce((a,b)=>a+b,0);
  return {trades:n,pnl_cents:pnl,win_rate:n?values.filter(x=>x>0).length/n:null,profit_factor:losses?gains/losses:null,
    mean_cents:mean,lower_mean_cents:n>=2?mean-1.96*Math.sqrt(variance/n):null,max_drawdown:dd,
    market_trades:trades.filter(t=>t.source==='MARKET').length,distinct_tokens:new Set(trades.map(t=>t.token_id)).size};
}
export function evaluateCandidate(samples,params,protocol=PROTOCOL) {
  const outcomes=samples.map(s=>episodeTrade(s,params,protocol));
  const closed=outcomes.filter(t=>t.state==='CLOSED').sort((a,b)=>a.entry_at-b.entry_at);
  const accepted=[],open=[];let cash=protocol.capital_cents,day=null,dayPnl=0;
  for(const trade of closed){
    open.sort((a,b)=>a.exit_at-b.exit_at);
    while(open.length&&open[0].exit_at<=trade.entry_at){const t=open.shift();cash+=t.cost_cents+t.pnl_cents;const d=Math.floor(t.exit_at/86400000);if(d!==day){day=d;dayPnl=0;}dayPnl+=t.pnl_cents;}
    const d=Math.floor(trade.entry_at/86400000);if(d!==day){day=d;dayPnl=0;}
    if(open.length>=protocol.max_positions||dayPnl<=-protocol.daily_loss_cents||cash-trade.cost_cents<protocol.capital_cents*protocol.reserve_pct/100)continue;
    cash-=trade.cost_cents;open.push(trade);accepted.push(trade);
  }
  const unpriced=outcomes.filter(t=>t.state==='UNPRICED'||t.state==='UNUSABLE').length;
  return {...metrics(accepted,protocol),unpriced,signals:closed.length+unpriced,coverage:closed.length+unpriced?closed.length/(closed.length+unpriced):0,
    // Missing exits cannot be counted at cost or silently removed as winners.
    worst_case_pnl_cents:accepted.reduce((n,t)=>n+t.pnl_cents,0)-unpriced*(protocol.order_cents+protocol.network_fee_cents),trade_records:accepted};
}
export function fitModel(samples,protocol=PROTOCOL) {
  const split=splitSamples(samples,protocol),params=candidatesFrom(split.train,protocol);
  if(!params.length||split.train.length<40||split.validation.length<15||split.test.length<15)return {status:'COLLECTING',trained:false,reason:params.length?'INSUFFICIENT_SPLITS':'INSUFFICIENT_WALLET_TRAIN',split};
  // Stage 1 sees train only. Validation selects among three predeclared finalists.
  const scored=params.map((p,i)=>({index:i,parameters:p,train:evaluateCandidate(split.train,p,protocol)}));
  const finalists=scored.filter(c=>c.train.trades>=protocol.min_train_trades&&c.train.unpriced===0)
    .sort((a,b)=>b.train.lower_mean_cents-a.train.lower_mean_cents||a.index-b.index).slice(0,3);
  for(const c of finalists)c.validation=evaluateCandidate(split.validation,c.parameters,protocol);
  const ranked=finalists.filter(c=>c.validation.trades>=protocol.min_validation_trades&&c.validation.unpriced===0)
    .sort((a,b)=>b.validation.lower_mean_cents-a.validation.lower_mean_cents||a.index-b.index);
  const selected=ranked[0];
  if(!selected)return {status:'REJECTED',trained:true,reason:'NO_CANDIDATE_WITH_COVERAGE',split,candidates:scored,candidate_count:params.length};
  // Test outcomes are read only after parameter selection and never select a model.
  const test=evaluateCandidate(split.test,selected.parameters,protocol);
  const control=evaluateCandidate(split.test,baseline,protocol);
  const span=samples.at(-1).anchor_at-samples[0].anchor_at;
  const checks={test_sample:test.trades>=protocol.min_test_trades,independent_market_entries:test.market_trades>=protocol.min_market_test_trades,
    complete_prices:test.unpriced===0&&control.unpriced===0,positive_validation:selected.validation.lower_mean_cents>0,
    positive_test:test.lower_mean_cents>0,better_than_baseline:test.pnl_cents>control.pnl_cents,
    drawdown:test.max_drawdown<=.1,observation_span:span>=protocol.min_span_ms};
  return {status:Object.values(checks).every(Boolean)?'PAPER_ELIGIBLE':'REJECTED',trained:true,selected: selected.index,
    parameters:selected.parameters,train:selected.train,validation:selected.validation,test,baseline:control,checks,
    candidates:scored,candidate_count:params.length,split,span_ms:span,
    limitations:['Estimated historical costs and sampled prices; executable historical routes unavailable.',
      'Wallet-selected and indexed-token universe; this is not a causal model of trader intent.',
      'Normal-approximation mean bounds are screening heuristics, not a guarantee of profit.',
      'Future PAPER evidence is required. Training never authorizes LIVE.']};
}
