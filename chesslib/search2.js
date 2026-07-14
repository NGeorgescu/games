/* ==================================================================
   chesslib/search2.js  —  stronger generic search (same eval as search.js).

   Public interface mirrors createSearch: createSearch2(engine) returns
   { WEIGHTS, LEVELS, OPENING_PLIES, evaluate, searchMove, analyze,
     pickOpeningMove, ... }.

   The EVALUATION (evaluate + quiesce + WEIGHTS) is copied VERBATIM from
   search.js so that a head-to-head match isolates *search quality*.  The
   search adds: PVS, null-move pruning (conservative, zugzwang/mate-safe),
   late-move reductions, killer + history move ordering, and aspiration
   windows, on top of iterative deepening + TT + quiescence + the
   time-abort-discard fix.

   Terminal / stalemate scoring honours config.rules.stalemate exactly like
   the baseline: a no-move-not-in-check node returns +MATE when
   stalemate==='win', 0 when 'draw'.
   ================================================================== */

export function createSearch2(engine){
  const {
    config, W, H, WHITE, BLACK, IDX, XOF, YOF, inb, KING8, pawnType,
    legalMoves, makeMove, unmakeMove, key, sameMove, inCheck, kingSquare,
  } = engine;

  const WEIGHTS = config.weights;
  const LEVELS  = config.levels;
  const TYPES   = config.types;
  const crazyhouse = !!config.rules.crazyhouse;
  const stalemateWin = (config.rules.stalemate || 'win') === 'win';
  const stalemateLose = (config.rules.stalemate) === 'lose';   // Clobber: no move = you lose
  const evalMode = config.eval ? config.eval.mode : null;      // 'mobility' for Clobber
  const useQuiesce = config.rules.quiesce !== false;           // off for capture-only games
  const centralPiece = config.eval ? config.eval.centralPiece : null;
  const centralKey   = config.eval ? config.eval.centralWeightKey : null;
  const OPENING_PLIES = config.openingPlies || 8;
  const royalType = engine.royalType;
  const midX = [W/2-1|0, W/2|0], midY = [H/2-1|0, H/2|0];

  const val = (w,t)=>w[t]||0;

  /* ---------- EVALUATION (verbatim copy of search.js) ---------- */
  function mobilityEval(state,w){
    const stm=state.turn;
    const myMob=legalMoves(state).length;
    state.turn=1-stm; const opMob=legalMoves(state).length; state.turn=stm;
    const diff=(stm===WHITE?1:-1)*(myMob-opMob);   // white-relative
    return diff*(w.mobility||8);
  }
  function evaluate(state,w){
    if(evalMode==='mobility') return mobilityEval(state,w);
    const b=state.board; let s=0;
    for(let i=0;i<b.length;i++){
      const p=b[i]; if(!p||p.t===engine.royalType) continue;
      const base=(p.promo&&crazyhouse)?val(w,pawnType):val(w,p.t), sign=p.c===WHITE?1:-1; s+=sign*base;
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

  /* ---------- move ordering (TT / MVV-LVA / killers / history) ---------- */
  function moveId(m){ return m.drop?('*'+m.drop+'@'+m.to):(m.from+'>'+m.to+(m.promo||'')); }
  function isCaptureMove(state,m){ return !m.drop && state.board[m.to]!=null; }

  function moveScore(state,m,w,ttBest,ply,cfg){
    if(ttBest&&sameMove(m,ttBest)) return 1e7;
    let sc=0;
    if(!m.drop){
      const v=state.board[m.to];
      if(v){ sc+=1e6 + (val(w,(v.promo&&crazyhouse)?pawnType:v.t))*10 - val(w,state.board[m.from].t)/10; }
      if(m.promo) sc+=5e5+val(w,m.promo);
    } else sc+=100;
    // killers (quiet-move refutations from sibling nodes)
    const kl=cfg.killers[ply];
    if(kl){ const id=moveId(m); if(kl[0]===id) sc+=9e5; else if(kl[1]===id) sc+=8e5; }
    // history for quiet moves
    if(m.drop || state.board[m.to]==null) sc += (cfg.history.get(moveId(m))||0);
    return sc;
  }
  function orderMoves(state,moves,w,ttBest,ply,cfg){
    return moves.map(m=>[moveScore(state,m,w,ttBest,ply,cfg),m]).sort((a,b)=>b[0]-a[0]).map(x=>x[1]);
  }
  function addKiller(cfg,ply,m){
    if(!cfg.killers[ply]) cfg.killers[ply]=[null,null];
    const kl=cfg.killers[ply], id=moveId(m);
    if(kl[0]!==id){ kl[1]=kl[0]; kl[0]=id; }
  }
  function addHistory(cfg,m,depth){
    const id=moveId(m); cfg.history.set(id,(cfg.history.get(id)||0)+depth*depth);
  }

  /* ---------- quiescence (verbatim copy of search.js) ---------- */
  function quiesce(state,alpha,beta,w,cfg){
    cfg.nodes++; const stand=(state.turn===WHITE?1:-1)*evaluate(state,w);
    if(stand>=beta) return beta; if(stand>alpha) alpha=stand;
    const caps=legalMoves(state).filter(m=>isCaptureMove(state,m)||m.promo);
    for(const m of orderMoves(state,caps,w,null,0,cfg)){
      const u=makeMove(state,m); const sc=-quiesce(state,-beta,-alpha,w,cfg); unmakeMove(state,u);
      if(sc>=beta) return beta; if(sc>alpha) alpha=sc;
    }
    return alpha;
  }

  /* ---------- null-move helpers ---------- */
  function nonPawnMaterial(state,c){
    let n=0; const b=state.board;
    for(let i=0;i<b.length;i++){ const p=b[i]; if(p&&p.c===c&&p.t!==royalType&&p.t!==pawnType) n++; }
    if(crazyhouse){ const h=state.hands[c]; for(const t of TYPES) if(t!==pawnType) n+=h[t]; }
    return n;
  }
  const isMate = (s,w)=>Math.abs(s)>w.MATE-1000;

  /* ---------- PVS negamax ---------- */
  function pvs(state,depth,alpha,beta,ply,w,cfg,seen,canNull){
    cfg.nodes++; if(cfg.stop()) return 0;
    const k=key(state), rep=seen.get(k)||0; if(rep>=1) return 0;   // repetition = draw
    const alphaOrig=alpha, tt=cfg.tt.get(k); let ttBest=null;
    if(tt&&tt.depth>=depth){
      if(tt.flag===0) return tt.value;
      if(tt.flag===-1&&tt.value>alpha) alpha=tt.value;
      if(tt.flag===1&&tt.value<beta) beta=tt.value;
      if(alpha>=beta) return tt.value;
    }
    if(tt) ttBest=tt.best;

    const moves=legalMoves(state);
    if(moves.length===0){
      if(inCheck(state.board,state.turn)) return -w.MATE+ply;
      if(stalemateLose) return -w.MATE+ply;              // no move = side to move loses
      return stalemateWin ? (w.MATE-ply) : 0;
    }
    if(depth<=0) return useQuiesce ? quiesce(state,alpha,beta,w,cfg)
                                   : (state.turn===WHITE?1:-1)*evaluate(state,w);

    const checked=inCheck(state.board,state.turn);

    // ---- Null-move pruning ----
    // Skip when: disabled, in check, shallow, beta is a mate score, or the side
    // to move has little material (zugzwang / stalemate-win traps on tiny boards).
    if(cfg.useNull && canNull && !checked && depth>=3 && Math.abs(beta)<w.MATE-1000
        && nonPawnMaterial(state,state.turn)>=1){
      const stand=(state.turn===WHITE?1:-1)*evaluate(state,w);
      if(stand>=beta){
        const R = depth>6?3:2;
        const t=state.turn; state.turn=1-t;
        const sc=-pvs(state,depth-1-R,-beta,-beta+1,ply+1,w,cfg,seen,false);
        state.turn=t;
        if(cfg.stop()) return 0;
        if(sc>=beta) return isMate(sc,w)?beta:sc;   // never let null hide a mate
      }
    }

    seen.set(k,rep+1);
    const ordered=orderMoves(state,moves,w,ttBest,ply,cfg);
    let best=-Infinity, bestMove=null, i=0;
    for(const m of ordered){
      const cap = isCaptureMove(state,m) || !!m.promo;
      const u=makeMove(state,m);
      const givesCheck=inCheck(state.board,state.turn);
      let sc;
      if(i===0){
        sc=-pvs(state,depth-1,-beta,-alpha,ply+1,w,cfg,seen,true);
      } else {
        // Late-move reduction for late, quiet, non-checking moves.
        let R=0;
        if(cfg.useLMR && depth>=3 && i>=3 && !cap && !checked && !givesCheck){
          R = (i>=6 && depth>=5) ? 2 : 1;
        }
        sc=-pvs(state,depth-1-R,-alpha-1,-alpha,ply+1,w,cfg,seen,true);
        if(sc>alpha && R>0) sc=-pvs(state,depth-1,-alpha-1,-alpha,ply+1,w,cfg,seen,true);
        if(sc>alpha && sc<beta) sc=-pvs(state,depth-1,-beta,-alpha,ply+1,w,cfg,seen,true);
      }
      unmakeMove(state,u);
      if(cfg.stop()){ seen.set(k,rep); return 0; }
      if(sc>best){ best=sc; bestMove=m; }
      if(best>alpha) alpha=best;
      if(alpha>=beta){
        if(!cap){ addKiller(cfg,ply,m); addHistory(cfg,m,depth); }
        break;
      }
      i++;
    }
    seen.set(k,rep);
    let flag=0; if(best<=alphaOrig) flag=1; else if(best>=beta) flag=-1;
    cfg.tt.set(k,{depth,value:best,flag,best:bestMove});
    return best;
  }

  /* ---------- root search: iterative deepening + aspiration ---------- */
  function searchMove(state,opts){
    opts=opts||{};
    const w=opts.weights||WEIGHTS, maxDepth=opts.maxDepth||64, timeMs=opts.timeMs||400;
    const deadline=performance.now()+timeMs;
    const cfg={
      tt:new Map(), nodes:0, killers:[], history:new Map(),
      stop:()=>performance.now()>deadline,
      // Null-move pruning is implemented (below) with the standard safeguards,
      // but on these TINY, zugzwang- and stalemate-win-prone boards an equal-time
      // ablation showed it is a slight NET NEGATIVE (LMR-only beat LMR+null), so
      // it is DEFAULT-OFF here. Pass opts.useNull:true to re-enable it.
      useNull: opts.useNull===true,
      useLMR:  opts.useLMR!==false,
    };
    const rootMoves=legalMoves(state);
    if(rootMoves.length===0) return {move:null,score:0,depth:0,nodes:0};
    let best={move:rootMoves[0],score:0,depth:0,nodes:0}, prevScore=0;

    for(let d=1;d<=maxDepth;d++){
      let alpha,beta,delta=Math.max(30,Math.abs(w.P)/3);
      if(d<=2){ alpha=-Infinity; beta=Infinity; } else { alpha=prevScore-delta; beta=prevScore+delta; }
      let localBest=null, localScore=-Infinity, aborted=false;

      // Aspiration re-search loop (widen on fail-high / fail-low).
      while(true){
        localBest=null; localScore=-Infinity; aborted=false;
        const seen=new Map();
        if(opts.history) for(const hk of opts.history) seen.set(hk,(seen.get(hk)||0)+1);
        const ttRoot=cfg.tt.get(key(state));
        const ordered=orderMoves(state,rootMoves,w,ttRoot&&ttRoot.best,0,cfg);
        let a=alpha, i=0;
        for(const m of ordered){
          const u=makeMove(state,m);
          let sc;
          if(i===0){
            sc=-pvs(state,d-1,-beta,-a,1,w,cfg,seen,true);
          } else {
            sc=-pvs(state,d-1,-a-1,-a,1,w,cfg,seen,true);
            if(sc>a && sc<beta) sc=-pvs(state,d-1,-beta,-a,1,w,cfg,seen,true);
          }
          unmakeMove(state,u);
          if(cfg.stop()){ aborted=true; break; }
          if(sc>localScore){ localScore=sc; localBest=m; }
          if(localScore>a) a=localScore;
          i++;
        }
        if(aborted) break;
        if(localScore<=alpha && alpha>-Infinity){ alpha=-Infinity; delta*=3; continue; } // fail low
        if(localScore>=beta  && beta<Infinity){ beta=Infinity;  delta*=3; continue; }    // fail high
        break;
      }

      // Only commit a fully-completed depth (time-abort-discard fix).
      if(!aborted&&localBest){ best={move:localBest,score:localScore,depth:d,nodes:cfg.nodes}; prevScore=localScore; }
      if(aborted||cfg.stop()) break;
      if(Math.abs(localScore)>w.MATE-100) break;
    }
    return best;
  }

  /* ---------- analysis: multi-PV + PV extraction (from search.js) ---------- */
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
  function analyze(state,depth,K,history){
    const w=WEIGHTS, rootMoves=legalMoves(state);
    if(rootMoves.length===0) return {depth,nodes:0,terminal:inCheck(state.board,state.turn)?'mate':'stalemate',lines:[]};
    const lines=[], excluded=new Set(); let nodes=0;
    for(let k=0;k<K&&excluded.size<rootMoves.length;k++){
      const cfg={tt:new Map(),nodes:0,killers:[],history:new Map(),stop:()=>false,useNull:true,useLMR:true};
      let alpha=-Infinity,bestM=null,bestSc=-Infinity;
      const seen=new Map(); if(history) for(const hk of history) seen.set(hk,(seen.get(hk)||0)+1);
      for(const m of orderMoves(state,rootMoves,w,null,0,cfg)){
        if(excluded.has(mvId(m))) continue;
        const u=makeMove(state,m); const sc=-pvs(state,depth-1,-Infinity,-alpha,1,w,cfg,seen,true); unmakeMove(state,u);
        if(sc>bestSc){bestSc=sc;bestM=m;} if(bestSc>alpha) alpha=bestSc;
      }
      nodes+=cfg.nodes; if(!bestM) break;
      excluded.add(mvId(bestM));
      lines.push({move:bestM,score:bestSc,pv:extractPV(state,bestM,depth,cfg.tt)});
    }
    return {depth,nodes,lines};
  }
  function pickOpeningMove(state,lvl,history){
    const depth=Math.min(lvl.maxDepth,4);
    const res=analyze(state,depth,6,history);
    const lines=res.lines; if(!lines.length) return null;
    const best=lines[0].score;
    const cands=lines.filter(l=>best-l.score<=60);
    const T=35; const wts=cands.map(l=>Math.exp((l.score-best)/T));
    const tot=wts.reduce((a,b)=>a+b,0); let r=Math.random()*tot;
    for(let i=0;i<cands.length;i++){ r-=wts[i]; if(r<=0) return cands[i].move; }
    return cands[cands.length-1].move;
  }

  return { WEIGHTS, LEVELS, OPENING_PLIES, evaluate, searchMove, analyze, pickOpeningMove };
}
