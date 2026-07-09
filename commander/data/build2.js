#!/usr/bin/env node
/* Combo-index rebuild. Streams the (>512MB, too big for readFileSync-as-string) Commander
 * Spellbook variants.json and enriches each color bundle with per-combo index metadata.
 *   1. curl -s https://json.commanderspellbook.com/variants.json -o .cache2/variants.json
 *   2. node --max-old-space-size=8192 build2.js
 * Emits W.json ... C.json, each:
 *   { v, cards:[name], combos:[[cardIdx]], cmeta:[[req,pre,feat,castMax,castTot]], tpl:[templateName], treq:[[tplIdx]] }
 * cmeta[i] / treq[i] align with combos[i]:
 *   req      = # non-card requirements (CSB `requires` templates — e.g. "a creature with persist")
 *   pre      = 1 if a notable game-state prerequisite
 *   feat     = payoff tier (0 win/damage/draw .. 3 weak trigger loop) from `produces`
 *   castMax  = highest CMC among cards that start in HAND (must be cast); reanimated/battlefield pieces excluded
 *   castTot  = sum of CMC of the cards that start in HAND    (so Animate Dead + Worldgorger Dragon = 2 mana)
 *   treq[i]  = local indices into tpl[] naming this combo's template requirements
 * A combo's identity is its named-card set PLUS its template signature, so two combos that share the same
 * named cards but need different templates stay distinct. Variants that collide are merged (min req/pre/feat).
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

function templatesOf(v){
  return (v.requires||[]).map(r=>{ const q=r.quantity||1, nm=(r.template&&r.template.name)||'requirement'; return q>1?q+'× '+nm:nm; }).sort();
}

(async()=>{
  console.log('streaming variants.json …');
  const nameById=new Map();
  const byCI=new Map();   // ci -> Map(setKey -> {ids, hand, tpls, req, pre, feat})
  let version=null;
  await streamVariants(v=>{
    const uses=v.uses||[]; if(!uses.length) return;
    // dedupe cards within a variant, remembering whether each starts in hand (must be cast)
    const byId=new Map();
    for(const u of uses){ const id=u.card.id; nameById.set(id,u.card.name);
      const hand=(u.zoneLocations||[]).includes('H');
      if(!byId.has(id)) byId.set(id,hand); else byId.set(id, byId.get(id)||hand); }
    const ids=[...byId.keys()].sort((a,b)=>a-b);
    const hand=ids.map(id=>byId.get(id));
    const tpls=templatesOf(v);
    const ci=(v.identity||'').replace(/[^WUBRG]/g,'');
    let ft=3; for(const p of (v.produces||[])){ const t=tier(p.feature&&p.feature.name); if(t<ft) ft=t; }
    const rec={ ids, hand, tpls, req:tpls.length, pre:(String(v.notablePrerequisites||'').trim()?1:0), feat:ft };
    let m=byCI.get(ci); if(!m){ m=new Map(); byCI.set(ci,m); }
    const key=ids.join(',')+'|'+tpls.join(';');         // identity = named cards + template requirements
    const ex=m.get(key);
    if(!ex) m.set(key,rec);
    else { ex.pre=Math.min(ex.pre,rec.pre); ex.feat=Math.min(ex.feat,rec.feat); }
  });
  try{ const fd=fs.openSync(SRC,'r'); const b=Buffer.alloc(200); fs.readSync(fd,b,0,200,0); fs.closeSync(fd); const mm=b.toString('utf8').match(/"version":\s*"([^"]+)"/); if(mm) version=mm[1]; }catch(e){}
  let sets=0; for(const m of byCI.values()) sets+=m.size;
  console.log('unique combos:',sets,'cards:',nameById.size,'version',version);

  // ---- Scryfall CMC for every used card, then hand-cast mana per combo ----
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
  for(const m of byCI.values()) for(const r of m.values()){
    let ctot=0, cmax=0;
    r.ids.forEach((id,k)=>{ if(!r.hand[k]) return; const c=cmcOf(nameById.get(id)); ctot+=c; if(c>cmax) cmax=c; });
    r.cmax=cmax; r.ctot=ctot;
  }

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
    const tpl=[]; const tplIdx=new Map();                 // per-bundle template dictionary
    const treq=recs.map(r=>r.tpls.map(s=>{ if(!tplIdx.has(s)){ tplIdx.set(s,tpl.length); tpl.push(s); } return tplIdx.get(s); }));
    const bundle={ v:version, cards,
      combos:recs.map(r=>r.ids.map(id=>local.get(id))),
      cmeta:recs.map(r=>[r.req,r.pre,r.feat,r.cmax,r.ctot]),
      tpl, treq };
    const s=JSON.stringify(bundle); fs.writeFileSync(path.join(OUT,(t||'C')+'.json'),s); total+=s.length;
  }
  fs.writeFileSync(path.join(OUT,'_meta.json'), JSON.stringify({version, timestamp:new Date().toISOString(), combos:sets, source:'https://json.commanderspellbook.com/variants.json', index:'v3: cmeta[req,pre,feat,castMax,castTot] + tpl/treq template requirements; mana = hand-cast cards only'}));
  console.log('DONE. 32 bundles, total raw', (total/1e6).toFixed(1)+'MB');
})();
