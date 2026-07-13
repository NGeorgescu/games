/* Gardner's Minichess — 5×5 standard chess (with a Queen). No crazyhouse. */
import { WHITE, BLACK, ORTH, DIAG, KING8, KNIGHT } from '../engine.js';

export default {
  id: 'gardner',
  title: "Gardner's Minichess",
  tagline: '5×5 · minichess',
  files: 5, ranks: 5,
  fileLetters: 'abcde',
  types: ['P','N','B','R','Q'],
  royalType: 'K', pawnType: 'P',

  pieces: {
    K: { name:'King',   letter:'K', royal:true, leaps:KING8 },
    Q: { name:'Queen',  letter:'Q', slides:KING8 },
    R: { name:'Rook',   letter:'R', slides:ORTH },
    B: { name:'Bishop', letter:'B', slides:DIAG },
    N: { name:'Knight', letter:'N', leaps:KNIGHT },
    P: { name:'Pawn',   letter:'',  pawn:{ double:false, enPassant:false } },
  },

  // Mirrored (reflection across the middle rank), like standard chess — NOT rotational.
  // White rank 1: Ra1 Nb1 Bc1 Qd1 Ke1, pawns a2–e2.
  // Black rank 5: Ra5 Nb5 Bc5 Qd5 Ke5, pawns a4–e4.  Kings face on e-file, queens on d-file.
  setup: [
    {x:0,y:0,t:'R',c:WHITE},{x:1,y:0,t:'N',c:WHITE},{x:2,y:0,t:'B',c:WHITE},{x:3,y:0,t:'Q',c:WHITE},{x:4,y:0,t:'K',c:WHITE},
    {x:0,y:1,t:'P',c:WHITE},{x:1,y:1,t:'P',c:WHITE},{x:2,y:1,t:'P',c:WHITE},{x:3,y:1,t:'P',c:WHITE},{x:4,y:1,t:'P',c:WHITE},
    {x:0,y:4,t:'R',c:BLACK},{x:1,y:4,t:'N',c:BLACK},{x:2,y:4,t:'B',c:BLACK},{x:3,y:4,t:'Q',c:BLACK},{x:4,y:4,t:'K',c:BLACK},
    {x:0,y:3,t:'P',c:BLACK},{x:1,y:3,t:'P',c:BLACK},{x:2,y:3,t:'P',c:BLACK},{x:3,y:3,t:'P',c:BLACK},{x:4,y:3,t:'P',c:BLACK},
  ],

  // Standard rules: no drops, no hands; stalemate is a DRAW; promote to Q/R/B/N.
  rules: { crazyhouse:false, stalemate:'draw', promoteTo:['Q','R','B','N'] },

  // Standard-ish material values (no hand bonus — there are no hands).
  weights: {"P":100,"N":300,"B":320,"R":500,"Q":900,"handBonus":0,"mobility":3.0,"kingExposure":6.0,"pawnAdvance":6.0,"centerN":8.0,"MATE":100000},
  eval: { centralPiece:'N', centralWeightKey:'centerN' },
  levels: {easy:{maxDepth:2,timeMs:150,blunder:0.35},medium:{maxDepth:6,timeMs:600,blunder:0.06},hard:{maxDepth:10,timeMs:1500,blunder:0},expert:{maxDepth:16,timeMs:3500,blunder:0},insane:{maxDepth:24,timeMs:3500,blunder:0,v2:true}},

  openingPlies: 8,

  // ---- UI text ----
  promoUiOrder: ['Q','R','B','N'],
  legend: [
    ['K','King','one step any direction. Royal — checkmate it to win.'],
    ['Q','Queen','slides any distance orthogonally or diagonally (all 8 directions), blocked by the first piece.'],
    ['R','Rook','slides any distance orthogonally (↑↓←→), blocked by the first piece.'],
    ['B','Bishop','slides any distance diagonally, blocked by the first piece.'],
    ['N','Knight','a standard knight leap — jumps over anything, nothing blocks it.'],
    ['P','Pawn','one step forward (no double step), captures diagonally, promotes to Q/R/B/N on the far rank.'],
  ],
  help: {
    title: "Gardner's Minichess",
    intro: 'A classic 5×5 minichess, invented by Martin Gardner (1969), played with the <strong>standard chess pieces including a Queen</strong> and the ordinary rules. <strong>Checkmate</strong> the enemy King to win.',
    setupLine: 'The start mirrors standard chess: White\'s back rank a1→e1 is <strong>Rook · Knight · Bishop · Queen · King</strong> with pawns on a2–e2; Black is the mirror image on rank 5, so both kings sit on the e-file and both queens on the d-file, facing each other.',
    stalemateLine: '<strong>Stalemate</strong> — if it\'s your turn and you have no legal move but you\'re not in check — is a <strong>draw</strong>, exactly as in standard chess. Threefold repetition is also a draw. There is no castling, no double pawn step and no en passant; a pawn reaching the far rank promotes to a Queen, Rook, Bishop or Knight.',
  },
};
