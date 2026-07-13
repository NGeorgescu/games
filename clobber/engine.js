/* ==================================================================
   clobber/engine.js — Clobber (5×6) rules + bot.

   Rules (standard Clobber):
     - 5 files (A–E) × 6 ranks (1–6) = 30 squares, all filled at start in a
       checkerboard pattern; A1 is a BLACK wazir.
     - Every stone is a wazir (one orthogonal step). A move = slide one of your
       stones onto an orthogonally-adjacent ENEMY stone, removing that enemy
       ("clobber"). Only captures exist — there are no quiet moves.
     - White moves first. The player who cannot move (no stone adjacent to any
       enemy) LOSES — i.e. the last player to capture wins.

   The bot is negamax + alpha-beta + a transposition table + iterative
   deepening with the time-abort-discard fix. The game is short (each move
   removes exactly one stone, so ≤29 plies), so deep search resolves the
   endgame exactly; the leaf heuristic is mobility difference.
   ================================================================== */

export const FILES = 5, RANKS = 6, CELLS = FILES * RANKS;
export const WHITE = 0, BLACK = 1, EMPTY = 2;

export const XOF = c => c % FILES;
export const YOF = c => (c / FILES) | 0;
export const IDX = (x, y) => y * FILES + x;
// A1 = file A (x0), rank 1 (y0), bottom-left. "c3" style names.
export const sqName = c => 'abcde'[XOF(c)] + (YOF(c) + 1);

// Orthogonal neighbours of each cell (precomputed).
export const NEIGH = (() => {
  const out = [];
  for (let c = 0; c < CELLS; c++) {
    const x = XOF(c), y = YOF(c), a = [];
    if (x > 0) a.push(c - 1);
    if (x < FILES - 1) a.push(c + 1);
    if (y > 0) a.push(c - FILES);
    if (y < RANKS - 1) a.push(c + FILES);
    out.push(a);
  }
  return out;
})();

// Initial checkerboard: A1 (x+y even) is BLACK, its neighbours WHITE.
export function initialBoard() {
  const b = new Int8Array(CELLS);
  for (let c = 0; c < CELLS; c++) b[c] = ((XOF(c) + YOF(c)) % 2 === 0) ? BLACK : WHITE;
  return b;
}

// A move is encoded as f*CELLS + t (from, to). Decode helpers:
export const mFrom = m => (m / CELLS) | 0;
export const mTo   = m => m % CELLS;
export const encode = (f, t) => f * CELLS + t;

// All legal clobbers for `side`: each own stone onto an adjacent enemy.
export function moves(b, side) {
  const opp = side ^ 1, out = [];
  for (let c = 0; c < CELLS; c++) {
    if (b[c] !== side) continue;
    const ns = NEIGH[c];
    for (let i = 0; i < ns.length; i++) if (b[ns[i]] === opp) out.push(c * CELLS + ns[i]);
  }
  return out;
}
export function hasMove(b, side) {
  const opp = side ^ 1;
  for (let c = 0; c < CELLS; c++) {
    if (b[c] !== side) continue;
    const ns = NEIGH[c];
    for (let i = 0; i < ns.length; i++) if (b[ns[i]] === opp) return true;
  }
  return false;
}
export function mobility(b, side) {
  const opp = side ^ 1; let n = 0;
  for (let c = 0; c < CELLS; c++) {
    if (b[c] !== side) continue;
    const ns = NEIGH[c];
    for (let i = 0; i < ns.length; i++) if (b[ns[i]] === opp) n++;
  }
  return n;
}

// Apply / undo a move in place (mutation, for search). `side` is the mover.
export function make(b, m, side) { const f = (m / CELLS) | 0, t = m % CELLS; b[t] = side; b[f] = EMPTY; }
export function unmake(b, m, side) { const f = (m / CELLS) | 0, t = m % CELLS; b[f] = side; b[t] = side ^ 1; }

// Terminal test: returns the winner (WHITE/BLACK) if `side` to move has no
// move (side loses), else -1.
export function terminalWinner(b, side) { return hasMove(b, side) ? -1 : (side ^ 1); }

// ---- bot ----------------------------------------------------------
const WIN = 1e6, MOB = 8;

export function createBot() {
  let tt, deadline, aborted, nodes;

  function key(b, side) {
    let k = '';
    for (let c = 0; c < CELLS; c++) k += b[c];
    return k + side;
  }

  // Negamax from `side` to move, value in side's perspective.
  function nm(b, side, depth, alpha, beta, ply) {
    if ((nodes++ & 2047) === 0 && performance.now() > deadline) { aborted = true; return 0; }
    const ml = moves(b, side);
    if (ml.length === 0) return -(WIN - ply);          // no move → side loses
    if (depth <= 0) return (ml.length - mobility(b, side ^ 1)) * MOB;

    const k = key(b, side), e = tt.get(k), a0 = alpha;
    let ttBest = -1;
    if (e && e.d >= depth) {
      if (e.f === 0) return e.v;
      if (e.f === 1) { if (e.v > alpha) alpha = e.v; } else { if (e.v < beta) beta = e.v; }
      if (alpha >= beta) return e.v;
    }
    if (e) ttBest = e.m;

    // Move ordering: TT best first, then centre-ward (cheap static tiebreak).
    if (ttBest >= 0 || ml.length > 1) {
      ml.sort((x, y) => scoreMove(y, ttBest) - scoreMove(x, ttBest));
    }

    let best = -Infinity, bestMove = ml[0], side2 = side ^ 1;
    for (let i = 0; i < ml.length; i++) {
      const m = ml[i];
      make(b, m, side);
      const sc = -nm(b, side2, depth - 1, -beta, -alpha, ply + 1);
      unmake(b, m, side);
      if (aborted) return best > -Infinity ? best : 0;
      if (sc > best) { best = sc; bestMove = m; if (sc > alpha) alpha = sc; }
      if (alpha >= beta) break;
    }
    let f = 0; if (best <= a0) f = 2; else if (best >= beta) f = 1;
    tt.set(k, { d: depth, v: best, f, m: bestMove });
    return best;
  }

  // Cheap static move score for ordering: TT move, then how central the target
  // is (central captures tend to matter more), then how connected it is.
  function scoreMove(m, ttBest) {
    if (m === ttBest) return 1e9;
    const t = m % CELLS, x = XOF(t), y = YOF(t);
    const cx = Math.min(x, FILES - 1 - x), cy = Math.min(y, RANKS - 1 - y);
    return (cx + cy) * 4 + NEIGH[t].length;
  }

  // Root search with iterative deepening. opts: {maxDepth,timeMs,blunder}.
  function bestMove(board, side, opts) {
    opts = opts || {};
    const maxDepth = opts.maxDepth || 12, timeMs = opts.timeMs || 800, blunder = opts.blunder || 0;
    const b = Int8Array.from(board);
    const root = moves(b, side);
    if (root.length === 0) return { move: null, score: -WIN, depth: 0 };
    if (root.length === 1) return { move: decode(root[0]), score: 0, depth: 0 };

    // Easy-tier random blunder: sometimes just play a random legal move.
    if (blunder > 0 && Math.random() < blunder) {
      const m = root[(Math.random() * root.length) | 0];
      return { move: decode(m), score: 0, depth: 0, random: true };
    }

    tt = new Map(); deadline = performance.now() + timeMs; nodes = 0;
    let best = { move: decode(root[0]), score: 0, depth: 0 }, side2 = side ^ 1;
    for (let d = 1; d <= maxDepth; d++) {
      aborted = false;
      let alpha = -Infinity, localBest = -1, localScore = -Infinity;
      const ordered = root.slice().sort((x, y) => scoreMove(y, tt.get(key(b, side))?.m ?? -1) - scoreMove(x, tt.get(key(b, side))?.m ?? -1));
      // small random jitter so non-optimal tiers vary their play
      const jitter = blunder > 0 ? 0.5 : 0;
      for (const m of ordered) {
        make(b, m, side);
        let sc = -nm(b, side2, d - 1, -Infinity, -alpha, 1);
        unmake(b, m, side);
        if (aborted) break;
        sc += jitter ? (Math.random() * jitter) : 0;
        if (sc > localScore) { localScore = sc; localBest = m; if (sc > alpha) alpha = sc; }
      }
      if (!aborted && localBest >= 0) best = { move: decode(localBest), score: localScore, depth: d, nodes };
      if (aborted || performance.now() > deadline) break;
      if (Math.abs(localScore) > WIN - 1000) break;   // forced result found
    }
    return best;
  }

  function decode(m) { return { from: (m / CELLS) | 0, to: m % CELLS }; }

  return { bestMove };
}
