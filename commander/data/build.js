#!/usr/bin/env node
// Regenerate the combo bundles used by step 7 ("one-away" finder).
//   1. curl -s https://json.commanderspellbook.com/variants.json -o /tmp/variants.json
//   2. node --max-old-space-size=8192 build.js /tmp/variants.json
// Emits W.json, WB.json, ... C.json (one per color identity). Each bundle is
// self-contained: { v, cards:[names], combos:[[localCardIndex,...]] } and holds
// every combo whose color identity is a SUBSET of the file's identity, so the
// client fetches exactly one file (its commander's CI) and never needs a shared dict.
const fs=require('fs'), path=require('path');
const src=process.argv[2]||'/tmp/variants.json';
const j=JSON.parse(fs.readFileSync(src,'utf8'));
const V=j.variants;
const nameById=new Map();
for(const v of V) for(const u of v.uses) nameById.set(u.card.id,u.card.name);
const byCI={};
for(const v of V){
  const ci=(v.identity||'').replace(/[^WUBRG]/g,'')||'';
  const set=[...new Set(v.uses.map(u=>u.card.id))].sort((a,b)=>a-b);
  (byCI[ci]=byCI[ci]||[]).push(set);
}
for(const ci in byCI){const seen=new Set(),o=[];for(const c of byCI[ci]){const k=c.join(',');if(!seen.has(k)){seen.add(k);o.push(c);}}byCI[ci]=o;}
const LET='WUBRG';
const subset=(a,b)=>[...a].every(c=>b.includes(c));
const outdir=__dirname;
let total=0;
for(let m=0;m<32;m++){
  let t='';for(let i=0;i<5;i++)if(m&(1<<i))t+=LET[i];
  let combos=[];
  for(const ci in byCI) if(subset(ci,t)) combos=combos.concat(byCI[ci]);
  const used=[...new Set(combos.flat())].sort((a,b)=>a-b);
  const local=new Map(); used.forEach((id,i)=>local.set(id,i));
  const bundle={v:j.version, cards:used.map(id=>nameById.get(id)), combos:combos.map(c=>c.map(id=>local.get(id)))};
  const fname=(t||'C')+'.json';
  const s=JSON.stringify(bundle);
  fs.writeFileSync(path.join(outdir,fname),s);
  total+=s.length;
}
fs.writeFileSync(path.join(outdir,'_meta.json'), JSON.stringify({version:j.version,timestamp:j.timestamp,combos:V.length,source:'https://json.commanderspellbook.com/variants.json'}));
console.log('wrote 32 bundles +_meta, total raw', (total/1e6).toFixed(1)+'MB');
