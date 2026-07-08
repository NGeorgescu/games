#!/usr/bin/env node
/* Combo-index rebuild. Streams the (>512MB, too big for readFileSync-as-string) Commander
 * Spellbook variants.json, enriches each color bundle with per-combo index metadata + per-card CMC.
 *   1. curl -s https://json.commanderspellbook.com/variants.json -o .cache2/variants.json
 *   2. node --max-old-space-size=8192 build2.js
 * Emits W.json ... C.json, each: { v, cards:[name], cmc:[int], combos:[[idx]], cmeta:[[req,pre,feat,mv]] }
 *   cmeta[i] aligns with combos[i]:  req=# non-card requirements (templates), pre=1 if a notable game-state
 *   prerequisite, feat=payoff tier (0=win/damage/draw .. 3=weak trigger loop), mv=mana value needed to
 *   execute. Bundles hold every combo whose color identity is a SUBSET of the file's identity.
 * Multiple variants can share a card set; we merge them keeping the easiest/best (min mv/req/pre/feat, max pop).
 */
const https=require('https'), fs=require('fs'), path=require('path');
const SRC=path.join(__dirname,'.cache2','variants.json');
const OUT=__dirname, DELAY=90;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function normName(s){ return String(s).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,''); }
function frontFace(nm){ return String(nm).split('//')[0].trim(); }
function tier(name){ const s=String(name).toLowerCase();
  if(/win the game|loses the game|lose the game|damage|infinite combat/.test(s)) return 0;
  if(/card draw|draw trigger|mill|lifeloss|life loss|\block\b/.test(s)) return 1;
  if(/mana|treasure|token|untap|counter on a creature|cast/.test(s)) return 2;
  return 3; }

// ---- streaming extraction of the top-level variants[] array ----
function streamVariants(onVariant){ return new Promise((res,rej)=>{
  const rs=fs.createReadStream(SRC,{encoding:'utf8'});
  let started=false, inStr=false, esc=false, depth=0, cap=null, count=0;
  rs.on('data',chunk=>{
    for(let i=0;i<chunk.length;i++){
      const ch=chunk[i];
      if(!started){ if(ch==='[') started=true; continue; }   // first '[' = the variants array
      if(cap===null){
        if(ch==='{'){ cap=['{']; depth=1; inStr=false; esc=false; }
        else if(ch===']'){ rs.destroy(); return; }             // end of array
        continue;                                              // skip whitespace/commas between elements
      }
      cap.push(ch);
      if(inStr){ if(esc) esc=false; else if(ch==='\\') esc=true; else if(ch==='"') inStr=false; continue; }
      if(ch==='"') inStr=true;
      else if(ch==='{'||ch==='[') depth++;
      else if(ch==='}'||ch===']'){ depth--; if(depth===0){ const obj=JSON.parse(cap.join('')); cap=null; onVariant(obj); if(++count%10000===0) console.log('  parsed',count); } }
    }
  });
  rs.on('close',()=>res(count)); rs.on('end',()=>res(count)); rs.on('error',rej);
}); }

function postJSON(url,body){ return new Promise((res,rej)=>{
  const data=JSON.stringify(body);
  const r=https.request(url,{method:'POST',headers:{'User-Agent':'combo-index-build/1.0','Accept':'application/json','Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},resp=>{
    if(resp.statusCode>=300){ resp.resume(); return rej(new Error('HTTP '+resp.statusCode)); }
    let s=''; resp.on('data',d=>s+=d); resp.on('end',()=>{ try{res(JSON.parse(s));}catch(e){rej(e);} });
  }); r.on('error',rej); r.write(data); r.end();
}); }

(async()=>{
  console.log('streaming variants.json …');
  const nameById=new Map();
  const byCI=new Map();   // ci -> Map(setKey -> {ids, mv,req,pre,feat,pop})
  let version=null;
  await streamVariants(v=>{
    const uses=v.uses||[]; if(!uses.length) return;
    for(const u of uses) nameById.set(u.card.id, u.card.name);
    const ids=[...new Set(uses.map(u=>u.card.id))].sort((a,b)=>a-b);
    const ci=(v.identity||'').replace(/[^WUBRG]/g,'');
    let ft=3; for(const p of (v.produces||[])){ const t=tier(p.feature&&p.feature.name); if(t<ft) ft=t; }
    const rec={ mv:v.manaValueNeeded||0, req:(v.requires||[]).length, pre:(String(v.notablePrerequisites||'').trim()?1:0), feat:ft, pop:v.popularity||0 };
    let m=byCI.get(ci); if(!m){ m=new Map(); byCI.set(ci,m); }
    const key=ids.join(','); const ex=m.get(key);
    if(!ex) m.set(key,{ids, ...rec});
    else { ex.mv=Math.min(ex.mv,rec.mv); ex.req=Math.min(ex.req,rec.req); ex.pre=Math.min(ex.pre,rec.pre); ex.feat=Math.min(ex.feat,rec.feat); ex.pop=Math.max(ex.pop,rec.pop); }
  });
  // version from the file head (cheap: read first 200 bytes)
  try{ const fd=fs.openSync(SRC,'r'); const b=Buffer.alloc(200); fs.readSync(fd,b,0,200,0); fs.closeSync(fd); const mm=b.toString('utf8').match(/"version":\s*"([^"]+)"/); if(mm) version=mm[1]; }catch(e){}
  let sets=0; for(const m of byCI.values()) sets+=m.size;
  console.log('unique card-sets:',sets,'cards:',nameById.size,'version',version);

  // ---- Scryfall CMC for every used card ----
  console.log('fetching CMC from Scryfall …');
  const names=[...new Set([...nameById.values()])];
  const cmcByNorm=new Map();
  for(let i=0;i<names.length;i+=75){
    const chunk=names.slice(i,i+75);
    try{ const j=await postJSON('https://api.scryfall.com/cards/collection',{identifiers:chunk.map(n=>({name:frontFace(n)}))});
      for(const c of (j.data||[])){ const mv=c.cmc||0; cmcByNorm.set(normName(c.name),mv); if(c.name.includes('//')) cmcByNorm.set(normName(frontFace(c.name)),mv); }
    }catch(e){ console.log('  scry batch fail',e.message); }
    await sleep(DELAY);
    if((i/75|0)%20===0) console.log('  cmc',Math.min(i+75,names.length)+'/'+names.length);
  }
  const cmcOf=nm=>{ const k=normName(nm); if(cmcByNorm.has(k)) return cmcByNorm.get(k); const f=normName(frontFace(nm)); return cmcByNorm.has(f)?cmcByNorm.get(f):0; };

  // ---- emit 32 bundles ----
  const LET='WUBRG';
  const subset=(a,b)=>[...a].every(c=>b.includes(c));
  let total=0;
  for(let mask=0;mask<32;mask++){
    let t=''; for(let i=0;i<5;i++) if(mask&(1<<i)) t+=LET[i];
    const recs=[];
    for(const [ci,m] of byCI){ if(subset(ci,t)) for(const r of m.values()) recs.push(r); }
    const used=[...new Set(recs.flatMap(r=>r.ids))].sort((a,b)=>a-b);
    const local=new Map(); used.forEach((id,i)=>local.set(id,i));
    const cards=used.map(id=>nameById.get(id));
    // cmeta[i] packed as [req, pre, feat, mv] to keep the 5-colour bundle small (pop dropped — unused by the index)
    const bundle={ v:version, cards, cmc:cards.map(cmcOf),
      combos:recs.map(r=>r.ids.map(id=>local.get(id))),
      cmeta:recs.map(r=>[r.req,r.pre,r.feat,r.mv]) };
    const s=JSON.stringify(bundle); fs.writeFileSync(path.join(OUT,(t||'C')+'.json'),s); total+=s.length;
  }
  fs.writeFileSync(path.join(OUT,'_meta.json'), JSON.stringify({version, timestamp:new Date().toISOString(), combos:sets, source:'https://json.commanderspellbook.com/variants.json', index:'v2: cmc[] + cmeta{mv,req,pre,feat,pop}'}));
  console.log('DONE. 32 bundles, total raw', (total/1e6).toFixed(1)+'MB');
})();
