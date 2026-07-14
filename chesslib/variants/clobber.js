/* Clobber — 5×6, all wazirs, capture-only, last-to-clobber wins.
   Not a chess variant: no royal piece, no check, no draws; the player with
   no legal move loses (stalemate:'lose'). Every move clobbers an adjacent
   enemy (captureOnly). Bot uses a mobility eval (material is meaningless). */
import { WHITE, BLACK, ORTH } from '../engine.js';

// All 30 squares filled in a checkerboard; A1 (0,0) is a BLACK wazir.
const setup = [];
for(let y=0;y<6;y++) for(let x=0;x<5;x++)
  setup.push({ x, y, t:'W', c:((x+y)%2===0)?BLACK:WHITE });

export default {
  id: 'clobber',
  name: 'clobber',
  title: 'Clobber',
  tagline: '5×6 · clobber',
  files: 5, ranks: 6,
  fileLetters: 'abcde',
  types: ['W'],
  royalType: 'K',   // no king on the board → kingSquare=-1 → no check/checkmate
  pawnType: 'P',    // no pawns

  pieces: {
    // A wazir that may ONLY move onto an adjacent enemy (captureOnly).
    W: { name:'Wazir', letter:'W', leaps:ORTH, captureOnly:true },
  },

  setup,

  // No hands/drops, no promotion; a side with no legal move LOSES; capture-only
  // games have no "quiet" positions, so quiescence is turned off.
  rules: { crazyhouse:false, stalemate:'lose', promoteTo:[], quiesce:false },

  // Material is meaningless (all stones identical); the bot evaluates the
  // difference in mobile-stone counts (see clobberEval in search.js).
  weights: { P:100, W:100, handBonus:0, mobility:50, kingExposure:0, pawnAdvance:0, centerN:0, MATE:100000 },
  eval: { mode:'clobber' },

  levels: {
    easy:   { maxDepth:2,  timeMs:150,  blunder:0.45 },
    medium: { maxDepth:6,  timeMs:500,  blunder:0.05 },
    hard:   { maxDepth:12, timeMs:1200, blunder:0 },
    expert: { maxDepth:20, timeMs:2500, blunder:0 },
    insane: { maxDepth:40, timeMs:3000, blunder:0, v2:true },
  },

  openingPlies: 4,

  // ---- UI text ----
  promoUiOrder: [],
  legend: [
    ['W','Wazir','one orthogonal step onto an adjacent enemy stone, removing it (a “clobber”). That is the only move — every move is a capture.'],
  ],
  help: {
    title: 'Clobber',
    intro: 'A 5×6 board packed with wazirs in a checkerboard; A1 is a black wazir. On your turn, move one of your wazirs one step (up/down/left/right) onto an <strong>adjacent enemy</strong> wazir, removing it. Every move is a capture — there are no quiet moves.',
    setupLine: 'All 30 squares start filled in a checkerboard and <strong>White moves first</strong>. Because you can only move onto an enemy, you need a stone beside an enemy stone to move at all.',
    stalemateLine: '<strong>If it\'s your turn and none of your stones sits next to an enemy, you have no move and you lose</strong> — so the last player able to clobber wins. There is no check, no checkmate and no draw.',
  },
};
