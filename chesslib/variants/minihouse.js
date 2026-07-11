/* Mini House Chess — 6×6 crazyhouse with the standard pieces (no queen). */
import { WHITE, BLACK, ORTH, DIAG, KING8, KNIGHT } from '../engine.js';

export default {
  id: 'minihouse',
  title: 'Mini House Chess',
  tagline: '6×6 · crazyhouse',
  files: 6, ranks: 6,
  fileLetters: 'abcdef',
  types: ['P','R','N','B'],
  royalType: 'K', pawnType: 'P',

  pieces: {
    K: { name:'King',   letter:'K', royal:true, leaps:KING8 },
    R: { name:'Rook',   letter:'R', slides:ORTH },
    N: { name:'Knight', letter:'N', leaps:KNIGHT },
    B: { name:'Bishop', letter:'B', slides:DIAG },
    P: { name:'Pawn',   letter:'',  pawn:{ double:false, enPassant:false } },
  },

  // White: K a1, R b1, N c1, B d1, pawn a2.  Black = 180° rotation (x,y)->(5-x,5-y).
  setup: [
    {x:0,y:0,t:'K',c:WHITE},{x:1,y:0,t:'R',c:WHITE},{x:2,y:0,t:'N',c:WHITE},{x:3,y:0,t:'B',c:WHITE},{x:0,y:1,t:'P',c:WHITE},
    {x:5,y:5,t:'K',c:BLACK},{x:4,y:5,t:'R',c:BLACK},{x:3,y:5,t:'N',c:BLACK},{x:2,y:5,t:'B',c:BLACK},{x:5,y:4,t:'P',c:BLACK},
  ],

  rules: { crazyhouse:true, stalemate:'win', promoteTo:['R','N','B'] },

  // Hand-tuned standard-ish crazyhouse values (no queen). Hand pieces ~1.3x board value.
  weights: {"P":100,"R":500,"N":300,"B":320,"handBonus":1.3,"mobility":2.0,"kingExposure":7.0,"pawnAdvance":6.0,"centerN":8.0,"MATE":100000},
  eval: { centralPiece:'N', centralWeightKey:'centerN' },
  levels: {easy:{maxDepth:2,timeMs:200,blunder:0.35},medium:{maxDepth:6,timeMs:700,blunder:0.06},hard:{maxDepth:12,timeMs:1800,blunder:0},insane:{maxDepth:20,timeMs:4000,blunder:0}},

  openingPlies: 8,

  // ---- UI text ----
  promoUiOrder: ['R','N','B'],
  legend: [
    ['K','King','one step any direction. Royal — checkmate it to win.'],
    ['R','Rook','slides any distance orthogonally (↑↓←→), blocked by the first piece.'],
    ['N','Knight','a standard knight leap — jumps over anything, nothing blocks it.'],
    ['B','Bishop','slides any distance diagonally, blocked by the first piece.'],
    ['P','Pawn','one step forward (no double step), captures diagonally, promotes to R/N/B on the far rank.'],
  ],
  help: {
    title: 'Mini House Chess',
    intro: 'A pocket chess variant on a 6×6 board with the standard pieces (no queen). Capture an enemy piece and it flips to <strong>your</strong> hand — on a later turn you may <strong>drop</strong> it back onto any empty square instead of moving (crazyhouse rules). <strong>Checkmate</strong> the enemy King to win.',
    setupLine: 'The start is a 180° rotation: White\'s back rank a1→d1 is <strong>King · Rook · Knight · Bishop</strong> with a pawn on a2; Black is the same shape rotated, so the kings sit on diagonally opposite corners.',
    dropsLine: '<strong>Crazyhouse drops:</strong> capturing a piece adds it to your hand (a promoted piece reverts to a pawn). On your turn you may drop a hand piece onto any empty square — pawns included, even on your own home rank or a middle rank. The only restriction: a pawn can\'t be dropped on its promotion rank (the far rank). A drop may give check or mate.',
  },
};
