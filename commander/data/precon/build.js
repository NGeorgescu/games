#!/usr/bin/env node
/* Build the commander -> precon index for the "step 0" precon alert.
 *   node build.js
 * Emits index.json: { "<normName>": { slug, precon, set, face, role } }  (one entry per commander)
 *   role: "face"  = the precon's main face commander
 *         "backup"= an is:commander card inside that precon sharing the face's color identity
 * Sources (same ones the page already uses):
 *   - EDHREC precon index:  https://json.edhrec.com/pages/precon.json
 *   - EDHREC precon page:   https://json.edhrec.com/pages/precon/<slug>.json   (face + full decklist)
 *   - Scryfall collection:  POST https://api.scryfall.com/cards/collection   (type_line + color_identity, batched <=75)
 * Strategy: fetch every precon page first, then do ONE deduped Scryfall pass over all card names
 *   (CI + commander-ness), then resolve faces/backups locally — keeps network calls ~200 not ~500.
 * Precon pages are cached under .cache/ so re-runs are fast / resumable.
 * Backup-commander rule (per spec): a deck card that is a legal commander AND shares the face's color identity.
 *   "Legal commander" ~= Legendary Creature, or oracle text containing "can be your commander".
 */
const https=require('https'), fs=require('fs'), path=require('path');
const DELAY=80, UA='combo-tool-precon-build/1.0';
const CACHE=path.join(__dirname,'.cache');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function normName(s){ return String(s).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,''); }
function ciKey(arr){ return (arr||[]).map(c=>c.toUpperCase()).sort().join('')||'C'; }
function log(...a){ console.log(...a); }

function getJSON(url){ return new Promise((res,rej)=>{
  https.get(url,{headers:{'User-Agent':UA,'Accept':'application/json'}},r=>{
    if(r.statusCode>=300){ r.resume(); return rej(new Error('HTTP '+r.statusCode)); }
    let s=''; r.on('data',d=>s+=d); r.on('end',()=>{ try{res(JSON.parse(s));}catch(e){rej(e);} });
  }).on('error',rej);
}); }
function postJSON(url,body){ return new Promise((res,rej)=>{
  const data=JSON.stringify(body);
  const r=https.request(url,{method:'POST',headers:{'User-Agent':UA,'Accept':'application/json','Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},resp=>{
    if(resp.statusCode>=300){ resp.resume(); return rej(new Error('HTTP '+resp.statusCode)); }
    let s=''; resp.on('data',d=>s+=d); resp.on('end',()=>{ try{res(JSON.parse(s));}catch(e){rej(e);} });
  }); r.on('error',rej); r.write(data); r.end();
}); }
async function getPrecon(slug){
  const f=path.join(CACHE,slug+'.json');
  if(fs.existsSync(f)){ try{ return JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){} }
  const j=await getJSON('https://json.edhrec.com/pages/precon/'+slug+'.json'); await sleep(DELAY);
  fs.writeFileSync(f, JSON.stringify(j));
  return j;
}

(async()=>{
  if(!fs.existsSync(CACHE)) fs.mkdirSync(CACHE);
  log('fetching precon index…');
  const idx=await getJSON('https://json.edhrec.com/pages/precon.json');
  const groups=(idx.container&&idx.container.json_dict&&idx.container.json_dict.cardlists)||[];
  const precons=[]; const seen=new Set();
  for(const g of groups){ const product=g.header||''; for(const cv of (g.cardviews||[])){
    const m=(cv.url||'').match(/\/precon\/([a-z0-9-]+)/i); if(!m||seen.has(m[1])) continue;
    seen.add(m[1]); precons.push({slug:m[1], product, faceHint:cv.name});
  }}
  log('precons:', precons.length);

  // 1. fetch every precon page (cached), collect face + full cardlist
  const decks=[]; const allNames=new Set();
  let n=0;
  for(const p of precons){
    try{
      const page=await getPrecon(p.slug);
      const deck=page.deck||{};
      const face=(deck.commander&&deck.commander[0])||p.faceHint;
      const precname=(page.header||'').replace(/\s+Precon$/i,'') || deck.name || p.slug;
      const cards=[]; const buckets=deck.cards||{};
      for(const t in buckets) for(const row of buckets[t]) cards.push(row[0]);
      allNames.add(face); cards.forEach(c=>allNames.add(c));
      decks.push({slug:p.slug, product:p.product, precon:precname, face, cards});
    }catch(e){ log('skip page', p.slug, e.message); }
    if(++n%20===0) log('  pages', n+'/'+precons.length);
  }

  // 2. ONE deduped Scryfall pass: normName -> {ci:[], commander:bool}
  const names=[...allNames]; const info=new Map();
  log('scryfall lookups for', names.length, 'unique cards…');
  for(let i=0;i<names.length;i+=75){
    const chunk=names.slice(i,i+75);
    try{ const j=await postJSON('https://api.scryfall.com/cards/collection',{identifiers:chunk.map(x=>({name:x}))});
      for(const c of (j.data||[])){ const tl=c.type_line||'', ot=c.oracle_text||'';
        const isCmd=(/Legendary/.test(tl) && /Creature/.test(tl)) || /can be your commander/i.test(ot);
        info.set(normName(c.name), {ci:c.color_identity||[], commander:isCmd}); }
    }catch(e){ log('  scry batch failed', e.message); }
    await sleep(DELAY);
    if((i/75|0)%5===0) log('  scry', Math.min(i+75,names.length)+'/'+names.length);
  }

  // 3. resolve faces + backups locally
  const index={}; let faces=0, backups=0;
  for(const d of decks){
    const fk=normName(d.face), fi=info.get(fk), faceCI=fi?ciKey(fi.ci):null;
    index[fk]={slug:d.slug, precon:d.precon, set:d.product, face:d.face, role:'face'}; faces++;
    if(!faceCI) continue;
    for(const nm of d.cards){ const k=normName(nm); if(k===fk||index[k]) continue;
      const ci=info.get(k); if(!ci||!ci.commander||ciKey(ci.ci)!==faceCI) continue;
      index[k]={slug:d.slug, precon:d.precon, set:d.product, face:d.face, role:'backup'}; backups++;
    }
  }
  fs.writeFileSync(path.join(__dirname,'index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(__dirname,'_meta.json'), JSON.stringify({source:'edhrec precon + scryfall', precons:precons.length, faces, backups, commanders:Object.keys(index).length}));
  log('DONE:', Object.keys(index).length, 'commanders ('+faces+' faces,', backups+' backups) -> index.json');
})();
