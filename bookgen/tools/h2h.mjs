/* Step-1 head-to-head: Rust bookgen engine vs JS search2, equal time/move.
 * Adjudicated with the shared JS engine. Rust move is fetched by spawning the
 * bookgen binary (`bestmove <variant> --key <k> --time <ms>`); its move id
 * format is byte-identical to the JS moveId, so we match it against legalMoves.
 */
import { execFileSync } from 'node:child_process';
import { createEngine } from '../../chesslib/engine.js';
import { createSearch2 } from '../../chesslib/search2.js';
import tinyCfg from '../../chesslib/variants/tinyhouse.js';
import miniCfg from '../../chesslib/variants/minihouse.js';
import gardnerCfg from '../../chesslib/variants/gardner.js';

const BIN = new URL('../target/release/bookgen', import.meta.url).pathname;
const TIME_MS = Number(process.env.TIME_MS || 200);
const GAMES = Number(process.env.GAMES || 20);
const MAX_PLIES = Number(process.env.MAX_PLIES || 60);

const VARIANTS = [
  { rustName: 'tiny', cfg: tinyCfg },
  { rustName: 'mini', cfg: miniCfg },
  { rustName: 'gardner', cfg: gardnerCfg },
];

function moveId(m) { return m.drop ? ('*' + m.drop + '@' + m.to) : (m.from + '>' + m.to + (m.promo || '')); }

function rustMove(rustName, key) {
  const out = execFileSync(BIN, ['bestmove', rustName, '--key', key, '--time', String(TIME_MS)],
    { encoding: 'utf8' }).trim();
  if (out === 'none') return null;
  return out.split('\t')[0]; // move id
}

function randInt(n) { return Math.floor(Math.random() * n); }

for (const { rustName, cfg } of VARIANTS) {
  const engine = createEngine(cfg);
  const s2 = createSearch2(engine);
  const stalemateWin = (cfg.rules.stalemate || 'win') === 'win';
  let rustW = 0, jsW = 0, draw = 0;

  for (let g = 0; g < GAMES; g++) {
    const state = engine.initialState();
    // Random opening: 2-4 random legal plies (same game for both engines).
    const openPlies = 2 + randInt(3);
    let broke = false;
    for (let i = 0; i < openPlies; i++) {
      const lm = engine.legalMoves(state);
      if (lm.length === 0) { broke = true; break; }
      engine.makeMove(state, lm[randInt(lm.length)]);
    }
    if (broke) { g--; continue; }

    const rustIsWhite = (g % 2 === 0);
    const seen = new Map();
    let result = null; // 'rust' | 'js' | 'draw'
    let ply = 0;
    while (true) {
      const lm = engine.legalMoves(state);
      if (lm.length === 0) {
        const mated = engine.inCheck(state.board, state.turn);
        if (mated) {
          // side to move is checkmated -> the other side wins
          const loserIsWhite = (state.turn === engine.WHITE);
          const rustLost = (loserIsWhite === rustIsWhite);
          result = rustLost ? 'js' : 'rust';
        } else {
          // stalemate: win for the side to move (stalemateWin) else draw
          if (stalemateWin) {
            const winnerIsWhite = (state.turn === engine.WHITE);
            const rustWon = (winnerIsWhite === rustIsWhite);
            result = rustWon ? 'rust' : 'js';
          } else result = 'draw';
        }
        break;
      }
      const k = engine.key(state);
      const rc = (seen.get(k) || 0) + 1; seen.set(k, rc);
      if (rc >= 3) { result = 'draw'; break; }
      if (ply >= MAX_PLIES) { result = 'draw'; break; }

      const whiteToMove = (state.turn === engine.WHITE);
      const rustToMove = (whiteToMove === rustIsWhite);
      let chosen = null;
      if (rustToMove) {
        const id = rustMove(rustName, k);
        chosen = lm.find(m => moveId(m) === id) || null;
        if (!chosen) throw new Error(`rust move ${id} not legal at ${k}`);
      } else {
        const r = s2.searchMove(state, { timeMs: TIME_MS });
        chosen = r.move;
        if (!chosen) { result = 'draw'; break; }
      }
      engine.makeMove(state, chosen);
      ply++;
    }

    if (result === 'rust') rustW++;
    else if (result === 'js') jsW++;
    else draw++;
    process.stderr.write(`  ${rustName} g${g} (${rustIsWhite ? 'R=W' : 'R=B'}) -> ${result} [${ply}p]\n`);
  }
  console.log(`${rustName}: Rust ${rustW} - ${jsW} JS - ${draw} D  (of ${GAMES}, ${TIME_MS}ms/move)`);
}
