/* ==================================================================
   chesslib/montecarlo.js — a Monte-Carlo evaluator for games whose
   positions are near-balanced under exact minimax (e.g. Clobber, where
   openings have game-value ≈ 0 so a depth search just reports 0.0).

   Instead of a static eval + alpha-beta, each candidate move is scored by
   the win rate of random playouts, giving a continuous, differentiated
   signal (a win probability) that is meaningful to display and to play by.
   Cheap exact tactics are layered on top: an immediate win is taken, and a
   move that hands the opponent an immediate win is refused.

   createMC(engine) mirrors the parts of createSearch that ui.js consumes:
   { WEIGHTS, LEVELS, OPENING_PLIES, searchMove, analyze, pickOpeningMove }.
   ================================================================== */
import { WHITE } from './engine.js';

export function createMC(engine){
  const { config, legalMoves, makeMove, unmakeMove } = engine;
  const WEIGHTS = config.weights, LEVELS = config.levels;
  const OPENING_PLIES = config.openingPlies || 8;
  const MATE = WEIGHTS.MATE;

  // side to move has no move → it loses.
  function noMove(state){ return legalMoves(state).length===0; }

  // one uniform-random playout to the end; returns the winning color.
  function playout(state){
    const undos=[]; let winner;
    while(true){
      const ml=legalMoves(state);
      if(ml.length===0){ winner = state.turn^1; break; }
      undos.push(makeMove(state, ml[(Math.random()*ml.length)|0]));
    }
    for(let i=undos.length-1;i>=0;i--) unmakeMove(state,undos[i]);
    return winner;
  }

  // win probability → centipawn-ish score (mover perspective) so it reads like a
  // normal eval and the sigmoid eval-bar recovers the probability exactly.
  function pToCp(p){ const q=Math.min(0.985,Math.max(0.015,p)); return Math.round(400*Math.log10(q/(1-q))); }

  // Classify a root move with cheap 2-ply tactics; return {kind,score} where
  // kind: 'win' (immediate), 'loss' (opponent has an immediate win reply), or 'play'.
  function tacticOfMove(state, m){
    const mover = state.turn;
    const u = makeMove(state, m);            // now opponent to move
    let kind;
    if(noMove(state)) kind='win';            // opponent has no reply → mover wins now
    else {
      let oppWins=false;
      for(const om of legalMoves(state)){
        const u2=makeMove(state, om);        // back to mover
        if(noMove(state)) oppWins=true;      // opponent can leave mover with no move
        unmakeMove(state, u2);
        if(oppWins) break;
      }
      kind = oppWins ? 'loss' : 'play';
    }
    unmakeMove(state, u);
    return kind;
  }

  // Evaluate every legal root move; returns [{move,kind,p,score}] sorted best-first
  // (mover perspective). `budgetPlayouts` random playouts are split over the moves
  // that need sampling.
  function evalRoot(state, budgetPlayouts){
    const mover = state.turn, moves = legalMoves(state);
    const rows = moves.map(m=>({move:m, kind:tacticOfMove(state,m), wins:0, n:0, p:0.5}));
    const playable = rows.filter(r=>r.kind==='play');
    if(playable.length){
      const per = Math.max(20, Math.floor(budgetPlayouts/playable.length));
      for(const r of playable){
        const u = makeMove(state, r.move);   // opponent to move
        for(let k=0;k<per;k++){ if(playout(state)===mover) r.wins++; r.n++; }
        unmakeMove(state, u);
        r.p = r.wins/r.n;
      }
    }
    for(const r of rows){
      if(r.kind==='win') r.score = MATE-1;
      else if(r.kind==='loss') r.score = -(MATE-2);
      else r.score = pToCp(r.p);
    }
    rows.sort((a,b)=>b.score-a.score);
    return rows;
  }

  // ---- public: bot move (time-bounded) ----
  function searchMove(state, opts){
    opts = opts || {};
    const moves = legalMoves(state);
    if(moves.length===0) return {move:null, score:-MATE, depth:0};
    if(moves.length===1) return {move:moves[0], score:0, depth:0};
    const deadline = performance.now() + (opts.timeMs||600);
    // progressive: keep sampling until time runs out, doubling the budget.
    let budget = Math.max(200, moves.length*30), rows = evalRoot(state, budget);
    while(performance.now() < deadline && budget < 20000){
      budget *= 2; rows = evalRoot(state, budget);
    }
    // small random tiebreak among (near-)equal best playable moves for variety
    const best = rows[0].score;
    const ties = rows.filter(r=>r.score>=best-8);
    const pick = ties[(Math.random()*ties.length)|0];
    return {move:pick.move, score:rows[0].score, depth:budget, nodes:budget};
  }

  // ---- public: multi-PV analysis ----
  function analyze(state, depth, K, history){
    const moves = legalMoves(state);
    if(moves.length===0) return {depth,nodes:0,terminal:'stalemate',lines:[]};
    const budget = 60 * Math.max(1, depth) * Math.max(4, moves.length);
    const rows = evalRoot(state, budget);
    const lines = rows.slice(0, K).map(r=>({move:r.move, score:r.score, pv:[r.move]}));
    return {depth, nodes:budget, lines};
  }

  // ---- opening variety: sample among the better playable moves ----
  function pickOpeningMove(state, lvl, history){
    const rows = evalRoot(state, Math.max(200, legalMoves(state).length*30));
    if(!rows.length) return null;
    const best = rows[0].score;
    const cands = rows.filter(r=>r.score>=best-40 && r.kind!=='loss');
    const pool = cands.length?cands:rows;
    return pool[(Math.random()*pool.length)|0].move;
  }

  return { WEIGHTS, LEVELS, OPENING_PLIES, searchMove, analyze, pickOpeningMove, evaluate:()=>0 };
}
