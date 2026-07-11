/* ==================================================================
   chesslib/search.js  —  generic bot: negamax + alpha-beta + iterative
   deepening (with the time-abort-discard fix) + quiescence + TT + move
   ordering, plus multi-PV analyze() and opening-variety pickOpeningMove().

   Evaluation is driven by the variant config's piece values + weights
   (material, hand bonus, king exposure, mobility, pawn advance, and a
   variant-specific centrality term).  The stalemate score honours the
   config's stalemate flag: a no-move-not-in-check node returns +MATE when
   stalemate==='win', 0 when 'draw'.
   ================================================================== */

export function createSearch(engine){
  const {
    config, W, H, WHITE, BLACK, IDX, XOF, YOF, inb, KING8, pawnType,
    legalMoves, makeMove, unmakeMove, key, sameMove, inCheck, kingSquare,
  } = engine;

  const WEIGHTS = config.weights;
  const LEVELS  = config.levels;
  const TYPES   = config.types;
  const stalemateWin = (config.rules.stalemate || 'win') === 'win';
  const centralPiece = config.eval ? config.eval.centralPiece : null;
  const centralKey   = config.eval ? config.eval.centralWeightKey : null;
  const OPENING_PLIES = config.openingPlies || 8;
  // central 2×2 of the board (middle two files & ranks)
  const midX = [W/2-1|0, W/2|0], midY = [H/2-1|0, H/2|0];

  const val = (w,t)=>w[t]||0;

  function evaluate(state,w){
    const b=state.board; let s=0;
    for(let i=0;i<b.length;i++){
      const p=b[i]; if(!p||p.t===engine.royalType) continue;
      const base=p.promo?val(w,pawnType):val(w,p.t), sign=p.c===WHITE?1:-1; s+=sign*base;
      if(p.t===pawnType){ const adv=p.c===WHITE?YOF(i):(H-1-YOF(i)); s+=sign*adv*w.pawnAdvance; }
      if(centralPiece && p.t===centralPiece){
        const x=XOF(i),y=YOF(i);
        const central=(x===midX[0]||x===midX[1])&&(y===midY[0]||y===midY[1])?1:0;
        s+=sign*central*w[centralKey];
      }
    }
    for(const c of [WHITE,BLACK]){
      const sign=c===WHITE?1:-1, h=state.hands[c];
      for(const t of TYPES) s+=sign*h[t]*val(w,t)*w.handBonus;
    }
    for(const c of [WHITE,BLACK]){
      const k=kingSquare(b,c); if(k<0) continue;
      const x=XOF(k),y=YOF(k); let empt=0;
      for(const [dx,dy] of KING8){const nx=x+dx,ny=y+dy;if(!inb(nx,ny))continue;if(b[IDX(nx,ny)]==null)empt++;}
      const sign=c===WHITE?1:-1, oppHand=Object.values(state.hands[1-c]).reduce((a,v)=>a+v,0);
      s-=sign*empt*w.kingExposure*(1+Math.min(oppHand,4)*0.25);
    }
    s+=(state.turn===WHITE?1:-1)*legalMoves(state).length*w.mobility;
    return s;
  }

  function isCapture(state,m){ return !m.drop && state.board[m.to]!=null; }
  function moveScore(state,m,w,ttBest){
    if(ttBest&&sameMove(m,ttBest)) return 1e6; let sc=0;
    if(!m.drop){ const v=state.board[m.to]; if(v) sc+=1000+val(w,v.promo?pawnType:v.t)-val(w,state.board[m.from].t)/10; if(m.promo) sc+=500+val(w,m.promo); }
    else sc+=50;
    return sc;
  }
  function orderMoves(state,moves,w,ttBest){
    return moves.map(m=>[moveScore(state,m,w,ttBest),m]).sort((a,b)=>b[0]-a[0]).map(x=>x[1]);
  }
  function quiesce(state,alpha,beta,w,cfg){
    cfg.nodes++; const stand=(state.turn===WHITE?1:-1)*evaluate(state,w);
    if(stand>=beta) return beta; if(stand>alpha) alpha=stand;
    const caps=legalMoves(state).filter(m=>isCapture(state,m)||m.promo);
    for(const m of orderMoves(state,caps,w,null)){
      const u=makeMove(state,m); const sc=-quiesce(state,-beta,-alpha,w,cfg); unmakeMove(state,u);
      if(sc>=beta) return beta; if(sc>alpha) alpha=sc;
    }
    return alpha;
  }
  function negamax(state,depth,alpha,beta,ply,w,cfg,seen){
    cfg.nodes++; if(cfg.stop()) return 0;
    const k=key(state), rep=seen.get(k)||0; if(rep>=1) return 0;
    const alphaOrig=alpha, tt=cfg.tt.get(k); let ttBest=null;
    if(tt&&tt.depth>=depth){ if(tt.flag===0) return tt.value; if(tt.flag===-1&&tt.value>alpha) alpha=tt.value; if(tt.flag===1&&tt.value<beta) beta=tt.value; if(alpha>=beta) return tt.value; }
    if(tt) ttBest=tt.best;
    const moves=legalMoves(state);
    // House rule: no legal moves = you WIN unless in check (checkmate = loss).
    // When stalemate==='draw', a stalemated (not-in-check) node scores 0.
    if(moves.length===0){
      if(inCheck(state.board,state.turn)) return -w.MATE+ply;
      return stalemateWin ? (w.MATE-ply) : 0;
    }
    if(depth<=0) return quiesce(state,alpha,beta,w,cfg);
    seen.set(k,rep+1); let best=-Infinity, bestMove=null;
    for(const m of orderMoves(state,moves,w,ttBest)){
      const u=makeMove(state,m); const sc=-negamax(state,depth-1,-beta,-alpha,ply+1,w,cfg,seen); unmakeMove(state,u);
      if(sc>best){best=sc;bestMove=m;} if(best>alpha) alpha=best; if(alpha>=beta) break;
    }
    seen.set(k,rep);
    let flag=0; if(best<=alphaOrig) flag=1; else if(best>=beta) flag=-1;
    cfg.tt.set(k,{depth,value:best,flag,best:bestMove}); return best;
  }
  function searchMove(state,opts){
    const w=opts.weights||WEIGHTS, maxDepth=opts.maxDepth||6, timeMs=opts.timeMs||400;
    const deadline=performance.now()+timeMs, cfg={tt:new Map(),nodes:0,stop:()=>performance.now()>deadline};
    const rootMoves=legalMoves(state); if(rootMoves.length===0) return {move:null,score:0,depth:0};
    let best={move:rootMoves[0],score:0,depth:0};
    for(let d=1;d<=maxDepth;d++){
      let alpha=-Infinity,beta=Infinity,localBest=null,localScore=-Infinity,aborted=false;
      const seen=new Map(); if(opts.history) for(const hk of opts.history) seen.set(hk,(seen.get(hk)||0)+1);
      const ordered=orderMoves(state,rootMoves,w,cfg.tt.get(key(state))&&cfg.tt.get(key(state)).best);
      for(const m of ordered){
        const u=makeMove(state,m); const sc=-negamax(state,d-1,-beta,-alpha,1,w,cfg,seen); unmakeMove(state,u);
        if(cfg.stop()){aborted=true;break;} if(sc>localScore){localScore=sc;localBest=m;} if(localScore>alpha) alpha=localScore;
      }
      // Only commit a fully-completed depth; a time-aborted depth has a partial
      // (possibly -Infinity) score, so keep the last completed depth's result.
      if(!aborted&&localBest) best={move:localBest,score:localScore,depth:d,nodes:cfg.nodes};
      if(aborted||cfg.stop()) break; if(Math.abs(localScore)>w.MATE-100) break;
    }
    return best;
  }

  /* ---- analysis: multi-PV + principal-variation extraction ---- */
  function mvId(m){ return m.drop?('*'+m.drop+'@'+m.to):(m.from+'>'+m.to+(m.promo||'')); }
  function extractPV(state,firstMove,maxLen,tt){
    const pv=[firstMove], undos=[makeMove(state,firstMove)];
    while(pv.length<maxLen){
      const e=tt.get(key(state));
      if(!e||!e.best) break;
      if(!legalMoves(state).some(mm=>sameMove(mm,e.best))) break;
      pv.push(e.best); undos.push(makeMove(state,e.best));
    }
    for(let i=undos.length-1;i>=0;i--) unmakeMove(state,undos[i]);
    return pv;
  }
  // Top-K lines at a fixed depth. Scores are side-to-move perspective.
  function analyze(state,depth,K,history){
    const w=WEIGHTS, rootMoves=legalMoves(state);
    if(rootMoves.length===0) return {depth,nodes:0,terminal:inCheck(state.board,state.turn)?'mate':'stalemate',lines:[]};
    const lines=[], excluded=new Set(); let nodes=0;
    for(let k=0;k<K&&excluded.size<rootMoves.length;k++){
      const cfg={tt:new Map(),nodes:0,stop:()=>false};
      let alpha=-Infinity,bestM=null,bestSc=-Infinity;
      const seen=new Map(); if(history) for(const hk of history) seen.set(hk,(seen.get(hk)||0)+1);
      for(const m of orderMoves(state,rootMoves,w,null)){
        if(excluded.has(mvId(m))) continue;
        const u=makeMove(state,m); const sc=-negamax(state,depth-1,-Infinity,-alpha,1,w,cfg,seen); unmakeMove(state,u);
        if(sc>bestSc){bestSc=sc;bestM=m;} if(bestSc>alpha) alpha=bestSc;
      }
      nodes+=cfg.nodes; if(!bestM) break;
      excluded.add(mvId(bestM));
      lines.push({move:bestM,score:bestSc,pv:extractPV(state,bestM,depth,cfg.tt)});
    }
    return {depth,nodes,lines};
  }

  // Opening variety: pick randomly among near-best moves (softmax) so games
  // don't always follow the same line.
  function pickOpeningMove(state,lvl,history){
    const depth=Math.min(lvl.maxDepth,4);
    const res=analyze(state,depth,6,history);
    const lines=res.lines; if(!lines.length) return null;
    const best=lines[0].score;
    const cands=lines.filter(l=>best-l.score<=60);
    const T=35; const w=cands.map(l=>Math.exp((l.score-best)/T));
    const tot=w.reduce((a,b)=>a+b,0); let r=Math.random()*tot;
    for(let i=0;i<cands.length;i++){ r-=w[i]; if(r<=0) return cands[i].move; }
    return cands[cands.length-1].move;
  }

  return { WEIGHTS, LEVELS, OPENING_PLIES, evaluate, searchMove, analyze, pickOpeningMove };
}
