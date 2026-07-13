/* Repackage the generated books into chesslib/book.js's format:
 *  - shard by the FIRST CHARACTER of the key (prefix sharding; book.js routes
 *    a key to the shard whose id is the longest listed prefix of the key).
 *  - manifest carries a `shards: [...]` array (required by book.js) + stats.
 * Produces byte-for-byte the same layout the fixed Rust genbook now emits.
 */
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';

const BOOKS = new URL('../../chesslib/books/', import.meta.url).pathname;
const VARIANTS = ['tinyhouse', 'minihouse', 'gardner'];

for (const v of VARIANTS) {
  const dir = BOOKS + v;
  const old = JSON.parse(readFileSync(dir + '/manifest.json', 'utf8'));
  // merge existing shard files
  const map = {};
  const files = readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'manifest.json');
  for (const f of files) {
    const obj = JSON.parse(readFileSync(dir + '/' + f, 'utf8'));
    for (const [k, val] of Object.entries(obj)) map[k] = val;
    unlinkSync(dir + '/' + f); // remove old hash-named shard
  }
  const positions = Object.keys(map).length;

  // group by first char
  const groups = new Map();
  for (const [k, val] of Object.entries(map)) {
    const id = k[0];
    if (!groups.has(id)) groups.set(id, {});
    groups.get(id)[k] = val;
  }
  const shardIds = [...groups.keys()].sort();
  for (const id of shardIds) {
    writeFileSync(dir + '/' + id + '.json', JSON.stringify(groups.get(id)));
  }

  const manifest = {
    variant: v,
    engineVersion: old.engine || old.engineVersion || 'bookgen-0.1.0',
    plies: old.fullyCoveredPlies,
    depth: old.analysisDepth ?? old.depth,
    positions,
    shards: shardIds,
    targetPlies: old.targetPlies,
    fullyCoveredPlies: old.fullyCoveredPlies,
    deepestBookedPly: old.deepestBookedPly,
    stoppedEarly: old.stoppedEarly,
    topK: old.topK,
    startKey: old.startKey,
    shardScheme: 'key -> shard whose id is the longest listed prefix of the key (here: first character); shard file = <id>.json',
    schema: 'shard file = { key(): [{san,cp}, ...] }; cp is white-relative centipawns (int); array sorted best-for-side-to-move first; SAN matches chesslib/pgn.js',
    ttSize: old.ttSize, ttProbes: old.ttProbes, ttHits: old.ttHits, ttHitPct: old.ttHitPct,
    buildSeconds: old.buildSeconds,
  };
  writeFileSync(dir + '/manifest.json', JSON.stringify(manifest));
  console.log(`${v}: positions=${positions} shards=${shardIds.length} [${shardIds.join(' ')}]`);
}
