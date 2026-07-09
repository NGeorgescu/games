#!/usr/bin/env node
/* Resolve Commander Spellbook template requirements ("a creature with persist") into concrete cards and
 * fold them into the existing combo bundles, so a template becomes a real slot the client can check /
 * recommend against instead of an opaque placeholder.
 *   node tpl-resolve.js
 * For every template name used by a bundle: pull its scryfallQuery from CSB, resolve it on Scryfall
 * (ordered by EDHREC popularity, capped), and record the matching cards + color identity. Then for each
 * of the 32 bundles, append the in-identity filler cards to cards[] and write tplcards[] aligned to tpl[]:
 *   tplcards[localTplIdx] = [cardIdx,...]   // concrete cards (in this bundle's identity) that satisfy that template
 * Bundles gain cards[] entries + tplcards[]; combos/cmeta/treq are unchanged. Templates whose query CSB
 * doesn't provide are left unresolved (tplcards entry = []), so the client keeps the placeholder for those.
 */
const https=require('https'), fs=require('fs'), path=require('path');
const OUT=__dirname, DELAY=110, CAP=150, CACHE=path.join(__dirname,'.tplcache.json');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const LETSET=new Set(['W','U','B','R','G']);
function getJSON(url){ return new Promise((res,rej)=>{
  https.get(url,{headers:{'User-Agent':'combo-index-build/1.0','Accept':'application/json'}},r=>{
    if(r.statusCode>=300){ r.resume(); return rej(new Error('HTTP '+r.statusCode)); }
    let s=''; r.on('data',d=>s+=d); r.on('end',()=>{ try{res(JSON.parse(s));}catch(e){rej(e);} });
  }).on('error',rej);
}); }

async function allTemplates(){
  const map=new Map(); let url='https://backend.commanderspellbook.com/templates/?limit=100';
  while(url){ const d=await getJSON(url); for(const t of (d.results||[])) if(t.name) map.set(t.name, t.scryfallQuery||null); url=d.next; await sleep(DELAY); }
  return map;
}
async function resolveQuery(q){
  const cards=[]; let url='https://api.scryfall.com/cards/search?order=edhrec&unique=cards&q='+encodeURIComponent('('+q+') legal:commander');
  while(url && cards.length<CAP){
    let d; try{ d=await getJSON(url); }catch(e){ if(/HTTP 404/.test(e.message)) break; throw e; }
    for(const c of (d.data||[])){ cards.push({n:c.name, ci:(c.color_identity||[]).join('')}); if(cards.length>=CAP) break; }
    url=d.has_more?d.next_page:null; await sleep(DELAY);
  }
  return cards;
}

(async()=>{
  // 1. collect template names actually used across bundles
  const files=fs.readdirSync(OUT).filter(f=>/^[WUBRGC]+\.json$/.test(f) && f!=='_meta.json');
  const need=new Set();
  for(const f of files){ const b=JSON.parse(fs.readFileSync(path.join(OUT,f),'utf8')); for(const nm of (b.tpl||[])) need.add(nm); }
  console.log('bundles:',files.length,'unique templates used:',need.size);

  // 2. resolve each (cached)
  let resolved={}; if(fs.existsSync(CACHE)){ try{ resolved=JSON.parse(fs.readFileSync(CACHE,'utf8')); }catch(e){} }
  const csb=await allTemplates(); console.log('CSB templates with metadata:',csb.size);
  let done=0;
  for(const name of need){
    if(resolved[name]){ done++; continue; }
    const q=csb.get(name);
    if(!q){ resolved[name]={q:null, cards:[]}; console.log('  no query:',name); }
    else { try{ const cards=await resolveQuery(q); resolved[name]={q, cards}; console.log(`  ${cards.length}\t${name}`); }
           catch(e){ console.log('  FAIL',name,e.message); resolved[name]={q, cards:[]}; } }
    if(++done%10===0) fs.writeFileSync(CACHE, JSON.stringify(resolved));
  }
  fs.writeFileSync(CACHE, JSON.stringify(resolved));

  // 3. fold into each bundle
  function normName(s){ return String(s).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,''); }
  let grew=0;
  for(const f of files){
    const id=new Set(f.replace('.json','').split('').filter(c=>LETSET.has(c)));
    const b=JSON.parse(fs.readFileSync(path.join(OUT,f),'utf8'));
    const idxByName=new Map(); b.cards.forEach((n,i)=>idxByName.set(normName(n),i));
    const addCard=nm=>{ const k=normName(nm); if(idxByName.has(k)) return idxByName.get(k); const i=b.cards.length; b.cards.push(nm); idxByName.set(k,i); return i; };
    const inId=ci=>[...ci].every(c=>id.has(c));            // card colour identity subset of bundle identity
    const before=b.cards.length;
    b.tplcards=(b.tpl||[]).map(nm=>{
      const r=resolved[nm]; if(!r||!r.cards.length) return [];
      const idxs=[]; for(const c of r.cards){ if(!inId(c.ci)) continue; idxs.push(addCard(c.n)); }
      return idxs;
    });
    grew+=b.cards.length-before;
    fs.writeFileSync(path.join(OUT,f), JSON.stringify(b));
  }
  console.log('DONE. added', grew, 'filler card refs across bundles.');
})();
