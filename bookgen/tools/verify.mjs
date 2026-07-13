/* Verify generated books:
 *  - start key in book == JS engine.key(initialState)
 *  - for N sampled positions, re-run Rust `analyze` (cold TT) and confirm the
 *    stored SAN ordering + white-relative cp match (this also proves every
 *    stored SAN is a legal move, since analyze enumerates legalMoves).
 *  - cp sign sanity on a materially-imbalanced position.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createEngine } from '../../chesslib/engine.js';
import tinyCfg from '../../chesslib/variants/tinyhouse.js';
import miniCfg from '../../chesslib/variants/minihouse.js';
import gardnerCfg from '../../chesslib/variants/gardner.js';

const BIN = new URL('../target/release/bookgen', import.meta.url).pathname;
const BOOKS = new URL('../../chesslib/books/', import.meta.url).pathname;

const VARIANTS = [
  { rustName: 'tiny', dir: 'tinyhouse', cfg: tinyCfg },
  { rustName: 'mini', dir: 'minihouse', cfg: miniCfg },
  { rustName: 'gardner', dir: 'gardner', cfg: gardnerCfg },
];

function loadBook(dir) {
  const manifest = JSON.parse(readFileSync(BOOKS + dir + '/manifest.json', 'utf8'));
  const map = new Map();
  for (const f of readdirSync(BOOKS + dir)) {
    if (f === 'manifest.json' || !f.endsWith('.json')) continue;
    const obj = JSON.parse(readFileSync(BOOKS + dir + '/' + f, 'utf8'));
    for (const [k, v] of Object.entries(obj)) map.set(k, v);
  }
  return { manifest, map };
}

function analyze(rustName, key, depth) {
  const out = execFileSync(BIN, ['analyze', rustName, '--key', key, '--depth', String(depth)],
    { encoding: 'utf8' });
  const lines = out.split('\n').filter(l => /^\s*\d+\./.test(l));
  // "  1. Ka1-b2    score(stm)=      66.1  cp(white)=      66.1  0>5"
  return lines.map(l => {
    const m = l.match(/^\s*\d+\.\s+(\S+)\s+score\(stm\)=\s*(-?[\d.]+)\s+cp\(white\)=\s*(-?[\d.]+)/);
    return { san: m[1], cpWhite: Math.round(Number(m[3])) };
  });
}

for (const { rustName, dir, cfg } of VARIANTS) {
  const engine = createEngine(cfg);
  const { manifest, map } = loadBook(dir);
  const jsStart = engine.key(engine.initialState());
  const rustStart = execFileSync(BIN, ['key', rustName], { encoding: 'utf8' }).trim();
  const depth = manifest.depth ?? manifest.analysisDepth;

  console.log(`\n=== ${dir} ===`);
  console.log(`positions=${map.size} (manifest ${manifest.positions}), shards=${manifest.shardCount}, depth=${depth}, ttHitPct=${manifest.ttHitPct}`);
  console.log(`startKey match: book=${manifest.startKey === jsStart && map.has(manifest.startKey)} jsKey=${jsStart} rustKey=${rustStart} (js==rust: ${jsStart === rustStart})`);

  // sample positions
  const keys = [...map.keys()];
  const sample = [manifest.startKey];
  for (let i = 0; i < 8 && keys.length; i++) sample.push(keys[Math.floor(Math.random() * keys.length)]);

  // Meaningful invariants (the shared never-cleared TT makes exact cp non-
  // reproducible by a cold re-run — book values are deeper-informed — so we
  // check: (a) SAN set == full legal move set (legality+completeness);
  // (b) book #1 move is a top choice of a DEEPER cold search (not a blunder);
  // (c) cp is monotonically sorted best-for-stm.
  let setOk = 0, setBad = 0, top1Deep = 0, top3Deep = 0, sortedOk = 0;
  let worstGap = 0;
  const deeper = Math.min(depth + 2, 12);
  for (const key of sample) {
    const stored = map.get(key);
    const re = analyze(rustName, key, depth);
    const storedSans = new Set(stored.map(x => x.san));
    const reSans = new Set(re.map(x => x.san));
    const setEqual = storedSans.size === reSans.size && [...storedSans].every(s => reSans.has(s));
    if (setEqual) setOk++; else { setBad++; console.log(`  SAN-SET MISMATCH ${key}`); }

    // stm-sorted check: cpWhite must be sorted so stm score is descending.
    // turn is the last char of the key.
    const whiteToMove = key.slice(-1) === '0';
    let sorted = true;
    for (let i = 1; i < stored.length; i++) {
      const a = whiteToMove ? stored[i - 1].cp : -stored[i - 1].cp;
      const b = whiteToMove ? stored[i].cp : -stored[i].cp;
      if (b > a + 0.5) { sorted = false; break; }
    }
    if (sorted) sortedOk++; else console.log(`  NOT SORTED ${key}`);

    // book #1 vs a deeper cold search
    const dre = analyze(rustName, key, deeper);
    const bestSan = stored[0].san;
    const rank = dre.findIndex(x => x.san === bestSan);
    if (rank === 0) top1Deep++;
    if (rank >= 0 && rank < 3) top3Deep++;
    // cp gap of book's #1 vs deeper best (stm perspective)
    const stm = (v) => whiteToMove ? v : -v;
    const gap = stm(dre[0].cpWhite) - stm(rank >= 0 ? dre[rank].cpWhite : dre[dre.length-1].cpWhite);
    if (gap > worstGap) worstGap = gap;
  }
  const N = sample.length;
  console.log(`  SAN-set==legalset: ${setOk}/${N} (bad ${setBad})   cp-sorted: ${sortedOk}/${N}`);
  console.log(`  book#1 vs cold depth ${deeper}: top1=${top1Deep}/${N} top3=${top3Deep}/${N} worstStmGap=${worstGap.toFixed(0)}cp`);

  // cp sign sanity: remove a black non-royal piece from the start -> White up -> cp>0
  const upKey = makeImbalance(cfg, jsStart, engine, +1);
  const dnKey = makeImbalance(cfg, jsStart, engine, -1);
  if (upKey) { const a = analyze(rustName, upKey, Math.min(depth, 6)); console.log(`  sign(white up material): topCpWhite=${a[0].cpWhite} (expect >0)`); }
  if (dnKey) { const a = analyze(rustName, dnKey, Math.min(depth, 6)); console.log(`  sign(black up material): topCpWhite=${a[0].cpWhite} (expect <0)`); }
}

// Remove one enemy (side= +1 -> remove a black piece so White is up) non-royal
// piece from the board portion of the start key.
function makeImbalance(cfg, startKey, engine, side) {
  const barIdx = startKey.indexOf('|');
  const board = startKey.slice(0, barIdx).split('');
  const rest = startKey.slice(barIdx);
  const royal = (cfg.royalType || 'K');
  // side +1: White up => remove a lowercase (black) piece. side -1: remove an uppercase (white) piece.
  for (let i = 0; i < board.length; i++) {
    const ch = board[i];
    if (ch === '.' || ch === '*') continue;
    const isBlack = ch === ch.toLowerCase() && ch !== ch.toUpperCase();
    const isWhite = ch === ch.toUpperCase() && ch !== ch.toLowerCase();
    const upper = ch.toUpperCase();
    if (upper === royal) continue;
    if (side === +1 && isBlack) { board[i] = '.'; return board.join('') + rest; }
    if (side === -1 && isWhite) { board[i] = '.'; return board.join('') + rest; }
  }
  return null;
}
