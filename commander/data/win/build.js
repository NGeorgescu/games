#!/usr/bin/env node
/* Regenerate "winningest cards" bundles from EDHTop16's GraphQL (run server-side — no CORS / no API key needed there).
 *   node --max-old-space-size=4096 build.js
 * For every commander with >= MIN_ENTRIES entries in MIN_EVENT+ player POST-BAN events, emits <slug>.json:
 *   { cmd, entries, avgPerf, cards:[{name,n,lift}] }
 * Metric: size-aware performance. Each entry scores perf = (tournamentSize - standing)/tournamentSize
 *   (fraction of the field it beat — so top-4 of 64 == win of 16). A card's score is the shrunk mean perf
 *   of decks running it, divided by the commander's baseline mean perf (lift). Shrinkage kills small samples.
 */
const https=require('https'), fs=require('fs'), path=require('path');
const TP='POST_BAN', MIN_EVENT=16, MIN_ENTRIES=20, M=10, MIN_N=5, TOPK=40, DELAY=120;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function gql(query){return new Promise((res,rej)=>{const body=JSON.stringify({query});const r=https.request('https://edhtop16.com/api/graphql',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'User-Agent':'Mozilla/5.0'}},resp=>{let s='';resp.on('data',d=>s+=d);resp.on('end',()=>{try{res(JSON.parse(s))}catch(e){rej(e)}});});r.on('error',rej);r.write(body);r.end();});}
function slug(name){ return name.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/['’.]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,''); }

async function listCommanders(){
  const out=[]; let after=null;
  while(true){
    const q=`{ commanders(first:50, minEntries:${MIN_ENTRIES}, minTournamentSize:${MIN_EVENT}, timePeriod:${TP}, sortBy:POPULARITY${after?`, after:${JSON.stringify(after)}`:''}){ edges{ node{ name } } pageInfo{ hasNextPage endCursor } } }`;
    const r=await gql(q); await sleep(DELAY); const c=r.data.commanders;
    c.edges.forEach(e=>out.push(e.node.name)); after=c.pageInfo.endCursor;
    if(!c.pageInfo.hasNextPage) break;
  }
  return out;
}
async function fetchEntries(cmd){
  const entries=[]; let after=null;
  while(true){
    const q=`{ commander(name:${JSON.stringify(cmd)}){ entries(first:100, filters:{minEventSize:${MIN_EVENT}, timePeriod:${TP}}${after?`, after:${JSON.stringify(after)}`:''}){ edges{ node{ standing tournament{ size } maindeck{ name } } } pageInfo{ hasNextPage endCursor } } } }`;
    const r=await gql(q); await sleep(DELAY); const e=r.data.commander.entries;
    e.edges.forEach(x=>entries.push(x.node)); after=e.pageInfo.endCursor;
    if(!e.pageInfo.hasNextPage) break;
  }
  return entries;
}
function winners(entries){
  let sum0=0, E=0; const n={}, sp={};
  for(const e of entries){
    const N=e.tournament&&e.tournament.size; if(!N||!e.standing) continue;
    const perf=(N-e.standing)/N; sum0+=perf; E++;
    const seen=new Set();
    for(const c of e.maindeck||[]){ if(seen.has(c.name))continue; seen.add(c.name); n[c.name]=(n[c.name]||0)+1; sp[c.name]=(sp[c.name]||0)+perf; }
  }
  if(!E) return null;
  const p0=sum0/E;
  const all=Object.keys(n).filter(k=>n[k]>=MIN_N).map(k=>{ const sh=(sp[k]+M*p0)/(n[k]+M); return [k, n[k], +(sh/p0).toFixed(2)]; });
  const cards=[...all].sort((a,b)=>b[2]-a[2]).slice(0,TOPK);                          // winningest: highest lift
  const cuts=[...all].filter(x=>x[2]<1).sort((a,b)=>a[2]-b[2]).slice(0,TOPK);         // cut candidates: lift below the commander's average (negatively correlated with finishing well)
  // compact array format: { e:entries, p:avgPerf, c:[[name, appearances, lift], ...], cuts:[[name, appearances, lift], ...] }
  return {e:E, p:+p0.toFixed(3), c:cards, cuts};
}
(async()=>{
  const outdir=__dirname;
  const cmds=await listCommanders();
  console.log('commanders:', cmds.length);
  let done=0, written=0, skipped=0;
  const CONC=5;   // process commanders in parallel; each still self-throttles its own paged fetches via DELAY
  async function handle(cmd){
    const fp=path.join(outdir, slug(cmd)+'.json');
    try{
      if(fs.existsSync(fp)){ const ex=JSON.parse(fs.readFileSync(fp,'utf8')); if(ex && ex.cuts){ skipped++; return; } }   // resume: already regenerated
      const w=winners(await fetchEntries(cmd));
      if(w){ fs.writeFileSync(fp, JSON.stringify(w)); written++; }
    }catch(e){ console.log('skip', cmd, e.message); }
    finally{ if(++done%25===0) console.log(done+'/'+cmds.length+' ('+written+' written, '+skipped+' skipped)'); }
  }
  let next=0;
  const worker=async()=>{ while(next<cmds.length){ const i=next++; await handle(cmds[i]); } };
  await Promise.all(Array.from({length:CONC}, worker));
  fs.writeFileSync(path.join(outdir,'_meta.json'), JSON.stringify({source:'edhtop16 GraphQL', metric:'size-aware perf lift', timePeriod:TP, minEventSize:MIN_EVENT, minEntries:MIN_ENTRIES, shrinkage:M, minAppearances:MIN_N, commanders:written}));
  console.log('DONE', done, 'commanders,', written, 'bundles');
})();
