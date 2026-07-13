/* Validate the delivered books against chesslib/book.js's EXACT contract:
 *  - manifest passes book.js's validity gate: Array.isArray(m.shards).
 *  - book.js shardFor(): longest listed prefix of the key; every stored key
 *    must route to an existing shard file that contains it (no orphans).
 *  - the routed array is byte-identical to the stored one.
 */
import { readFileSync, existsSync } from 'node:fs';

const BOOKS = new URL('../../chesslib/books/', import.meta.url).pathname;
const VARIANTS = ['tinyhouse', 'minihouse', 'gardner'];

// copied verbatim from chesslib/book.js
function shardFor(m, k) {
  let best = null;
  for (const s of m.shards) {
    if (k.startsWith(s) && (best === null || s.length > best.length)) best = s;
  }
  return best;
}

let allOk = true;
for (const v of VARIANTS) {
  const dir = BOOKS + v + '/';
  const m = JSON.parse(readFileSync(dir + 'manifest.json', 'utf8'));
  const gate = m && Array.isArray(m.shards);           // book.js loadManifest gate
  const shardCache = {};
  const loadShard = (id) => shardCache[id] ??= JSON.parse(readFileSync(dir + id + '.json', 'utf8'));

  // rebuild the full key set from all shard files
  let total = 0, routedOk = 0, orphan = 0, mismatch = 0, missingFile = 0;
  for (const id of m.shards) {
    if (!existsSync(dir + id + '.json')) { missingFile++; continue; }
    const obj = loadShard(id);
    for (const [k, arr] of Object.entries(obj)) {
      total++;
      const routed = shardFor(m, k);
      if (routed == null) { orphan++; continue; }
      const rarr = loadShard(routed)[k];
      if (!rarr) { orphan++; continue; }
      if (JSON.stringify(rarr) !== JSON.stringify(arr)) { mismatch++; continue; }
      routedOk++;
    }
  }
  // start key must be routable + present
  const startRouted = shardFor(m, m.startKey);
  const startPresent = startRouted != null && existsSync(dir + startRouted + '.json') &&
    !!loadShard(startRouted)[m.startKey];

  const ok = gate && missingFile === 0 && orphan === 0 && mismatch === 0 && routedOk === total && startPresent;
  allOk &&= ok;
  console.log(`${v}: gate=${gate} positions=${total} routedOk=${routedOk} orphan=${orphan} mismatch=${mismatch} missingFile=${missingFile} startKeyResolves=${startPresent} => ${ok ? 'OK' : 'FAIL'}`);
}
console.log(allOk ? '\nALL BOOKS VALID for book.js' : '\nVALIDATION FAILED');
process.exit(allOk ? 0 : 1);
