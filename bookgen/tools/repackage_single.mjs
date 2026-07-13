/* Repackage each book into a SINGLE catch-all "" shard (file ".json"),
 * which chesslib/book.js explicitly supports ("a single catch-all '' shard").
 * This avoids case-conflicting shard filenames (D.json vs d.json) that Dropbox
 * / case-insensitive filesystems mangle. All three books are < 2 MB, so per the
 * task's threshold a single shard is appropriate.
 * Reconstructs the full map from ALL current *.json shard files (including any
 * Dropbox "Case Conflict" renamed ones and the hidden "..json").
 */
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';

const BOOKS = new URL('../../chesslib/books/', import.meta.url).pathname;
const VARIANTS = ['tinyhouse', 'minihouse', 'gardner'];

for (const v of VARIANTS) {
  const dir = BOOKS + v + '/';
  const m = JSON.parse(readFileSync(dir + 'manifest.json', 'utf8'));
  const map = {};
  const files = readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'manifest.json');
  for (const f of files) {
    const obj = JSON.parse(readFileSync(dir + f, 'utf8'));
    for (const [k, val] of Object.entries(obj)) map[k] = val;
  }
  const positions = Object.keys(map).length;
  // remove every old shard file
  for (const f of files) unlinkSync(dir + f);
  // write single catch-all shard
  writeFileSync(dir + '.json', JSON.stringify(map));

  m.shards = [''];
  m.positions = positions;
  m.shardScheme = 'single catch-all shard: id "" (empty prefix matches every key); shard file = ".json"';
  writeFileSync(dir + 'manifest.json', JSON.stringify(m));
  console.log(`${v}: positions=${positions} -> single shard ".json" (shards:[""])`);
}
