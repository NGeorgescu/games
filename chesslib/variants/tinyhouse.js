/* Tiny House Chess — 4×4 crazyhouse with fairy pieces. */
import { WHITE, BLACK, ORTH, DIAG, KING8, KNIGHT } from '../engine.js';

export default {
  id: 'tinyhouse',
  title: 'Tiny House Chess',
  tagline: '4×4 · crazyhouse · fairy pieces',
  files: 4, ranks: 4,
  fileLetters: 'abcd',
  types: ['P','W','F','D'],
  royalType: 'K', pawnType: 'P',

  pieces: {
    K: { name:'King',         letter:'K', royal:true, leaps:KING8 },
    W: { name:'Wazir',        letter:'W', leaps:ORTH },
    F: { name:'Ferz',         letter:'F', leaps:DIAG },
    D: { name:'Dragonknight', letter:'D', mao:true },
    P: { name:'Pawn',         letter:'',  pawn:{ double:false, enPassant:false } },
  },

  // White: K a1, W b1, D c1, F d1, pawn a2.  Black = 180° rotation (x,y)->(3-x,3-y).
  setup: [
    {x:0,y:0,t:'K',c:WHITE},{x:1,y:0,t:'W',c:WHITE},{x:2,y:0,t:'D',c:WHITE},{x:3,y:0,t:'F',c:WHITE},{x:0,y:1,t:'P',c:WHITE},
    {x:3,y:3,t:'K',c:BLACK},{x:2,y:3,t:'W',c:BLACK},{x:1,y:3,t:'D',c:BLACK},{x:0,y:3,t:'F',c:BLACK},{x:3,y:2,t:'P',c:BLACK},
  ],

  rules: { crazyhouse:true, stalemate:'win', promoteTo:['W','F','D'] },

  // Trained by offline self-play (greedy hill-climb over randomized-opening matches).
  weights: {"P":100,"W":246.14,"F":235.883,"D":188.726,"handBonus":1.489,"mobility":3.242,"kingExposure":7.133,"pawnAdvance":6.001,"centerD":8.336,"MATE":100000},
  eval: { centralPiece:'D', centralWeightKey:'centerD' },
  levels: {easy:{maxDepth:2,timeMs:150,blunder:0.35},medium:{maxDepth:6,timeMs:500,blunder:0.06},hard:{maxDepth:10,timeMs:1200,blunder:0},insane:{maxDepth:18,timeMs:3000,blunder:0}},

  openingPlies: 8,

  // ---- UI text ----
  promoUiOrder: ['D','W','F'],
  legend: [
    ['K','King','one step any direction. Royal — checkmate it to win.'],
    ['W','Wazir','one step orthogonally (↑↓←→).'],
    ['F','Ferz','one step diagonally.'],
    ['D','Dragonknight','a knight leap, but blocked if the square it "steps over" orthogonally is occupied (Xiangqi-horse style).'],
    ['P','Pawn','one step forward, captures diagonally, promotes on the far rank (no double step).'],
  ],
  help: {
    title: 'Tiny House Chess',
    intro: 'A pocket chess variant on a 4×4 board with four fairy pieces. Capture an enemy piece and it flips to <strong>your</strong> hand — on a later turn you may <strong>drop</strong> it back onto any empty square instead of moving (crazyhouse rules). <strong>Checkmate</strong> the enemy King to win.',
    setupLine: 'The start is a 180° rotation: White\'s back rank a1→d1 is <strong>King · Wazir · Dragonknight · Ferz</strong> with a pawn on a2; Black is the same shape rotated, so the kings sit on diagonally opposite corners.',
    dropsLine: '<strong>Crazyhouse drops:</strong> capturing a piece adds it to your hand (a promoted piece reverts to a pawn). On your turn you may drop a hand piece onto any empty square — pawns included, even on your own home rank. The only restriction: a pawn can\'t be dropped on its promotion rank (the far rank). A drop may give check or mate.',
  },
};
