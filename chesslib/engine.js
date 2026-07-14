/* ==================================================================
   chesslib/engine.js  —  generic, config-driven crazyhouse engine.

   Pure logic, no DOM.  Directly importable in Node.  createEngine(config)
   returns a bundle of functions bound to that variant's board size, piece
   movement specs, and rule flags.  Move generation is driven entirely by
   the config's per-piece movement primitives (leaps / slides / mao / pawn)
   plus a small set of rule flags (crazyhouse, stalemate, promoteTo).

   Movement primitives supported:
     leaps : [[dx,dy],...]      unobstructed leaper offsets (K, Knight, Wazir, Ferz)
     slides: [[dx,dy],...]      sliding rays until blocked (Rook, Bishop, Queen)
     mao   : true               hobbled knight (Xiangqi horse / Dragonknight):
                                knight-leap targets, blocked if the orthogonally
                                adjacent "leg" square toward the target is occupied
     royal : true               the king (defines check / checkmate)
     pawn  : {double,enPassant} color-relative forward move + diagonal capture +
                                promotion; double-step and en-passant are wired
                                behind flags but OFF for the current variants.

   Rule flags:  crazyhouse (hands + drops), stalemate:'win'|'draw',
   promoteTo:[...], pawn-drop restriction (banned on the promotion rank).
   ================================================================== */

export const WHITE = 0, BLACK = 1;

// Shared direction sets (import into variant configs to build piece specs).
export const ORTH   = [[1,0],[-1,0],[0,1],[0,-1]];
export const DIAG   = [[1,1],[1,-1],[-1,1],[-1,-1]];
export const KING8  = ORTH.concat(DIAG);
export const KNIGHT = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];

export function createEngine(config){
  const W = config.files, H = config.ranks;
  const types = config.types;                 // hand / drop order
  const pieces = config.pieces;               // letter -> spec
  const rules = config.rules;
  const crazyhouse = !!rules.crazyhouse;
  const promoteTo = rules.promoteTo || [];
  const royalType = config.royalType || 'K';
  const pawnType  = config.pawnType  || 'P';

  const IDX = (x,y)=>y*W+x, XOF=i=>i%W, YOF=i=>(i/W)|0;
  const inb = (x,y)=>x>=0&&x<W&&y>=0&&y<H;

  // The "leg" square a mao steps over when moving (dx,dy) from (x,y): the
  // orthogonally adjacent square one step toward the target along the long axis.
  function legSquare(x,y,dx,dy){
    if(Math.abs(dx)===2) return [x+(dx>0?1:-1), y];
    return [x, y+(dy>0?1:-1)];
  }

  function emptyHand(){ const h={}; for(const t of types) h[t]=0; return h; }

  function initialState(){
    const board = new Array(W*H).fill(null);
    for(const s of config.setup) board[IDX(s.x,s.y)] = {t:s.t, c:s.c, promo:false};
    return {board, hands:[emptyHand(), emptyHand()], turn:WHITE, history:[]};
  }

  // ---- attack detection (reverse of each movement spec) ----
  function attacked(board,i,by){
    const x=XOF(i), y=YOF(i);
    for(const [lt,spec] of Object.entries(pieces)){
      if(spec.leaps){
        // piece of type lt at square i-o attacks i via offset o (o in its leap set)
        for(const [dx,dy] of spec.leaps){
          const sx=x-dx, sy=y-dy; if(!inb(sx,sy)) continue;
          const p=board[IDX(sx,sy)]; if(p&&p.c===by&&p.t===lt) return true;
        }
      }
      if(spec.slides){
        // walk rays from i; symmetric dir sets => a hit means the slider reaches i
        for(const [dx,dy] of spec.slides){
          let nx=x+dx, ny=y+dy;
          while(inb(nx,ny)){
            const p=board[IDX(nx,ny)];
            if(p){ if(p.c===by&&p.t===lt) return true; break; }
            nx+=dx; ny+=dy;
          }
        }
      }
      if(spec.mao){
        // attacker at i+o (o a knight offset); it moves to i via -o, leg from its side
        for(const [dx,dy] of KNIGHT){
          const ax=x+dx, ay=y+dy; if(!inb(ax,ay)) continue;
          const p=board[IDX(ax,ay)]; if(!(p&&p.c===by&&p.t===lt)) continue;
          const [lx,ly]=legSquare(ax,ay,-dx,-dy);
          if(board[IDX(lx,ly)]==null) return true;
        }
      }
      if(spec.pawn){
        // pawn of color `by` moves forward df, captures diagonally; it attacks i
        // if it sits at (i.x-dx, i.y-df) for dx in {-1,1}
        const df = by===WHITE?1:-1;
        const fromY = y-df;
        for(const dx of [-1,1]){
          const nx=x-dx; if(!inb(nx,fromY)) continue;
          const p=board[IDX(nx,fromY)]; if(p&&p.c===by&&p.t===lt) return true;
        }
      }
    }
    return false;
  }

  function kingSquare(board,c){
    for(let i=0;i<board.length;i++){const p=board[i];if(p&&p.c===c&&p.t===royalType)return i;}
    return -1;
  }
  function inCheck(board,c){const k=kingSquare(board,c);return k>=0&&attacked(board,k,1-c);}

  function addPawn(moves,from,to,isPromo){
    if(isPromo){ for(const pt of promoteTo) moves.push({from,to,promo:pt}); }
    else moves.push({from,to});
  }

  function pseudoMoves(state){
    const {board,hands,turn}=state, moves=[], promoRank=turn===WHITE?H-1:0;
    for(let i=0;i<board.length;i++){
      const p=board[i]; if(!p||p.c!==turn) continue;
      const x=XOF(i), y=YOF(i), spec=pieces[p.t];
      if(spec.leaps){
        for(const [dx,dy] of spec.leaps){
          const nx=x+dx, ny=y+dy; if(!inb(nx,ny)) continue;
          const j=IDX(nx,ny), q=board[j];
          // captureOnly (Clobber wazir): a move must land on an enemy — no quiet moves.
          if(spec.captureOnly){ if(!(q&&q.c!==turn)) continue; }
          else if(q&&q.c===turn) continue;
          moves.push({from:i,to:j});
        }
      }
      if(spec.slides){
        for(const [dx,dy] of spec.slides){
          let nx=x+dx, ny=y+dy;
          while(inb(nx,ny)){
            const j=IDX(nx,ny), q=board[j];
            if(q){ if(q.c!==turn) moves.push({from:i,to:j}); break; }
            moves.push({from:i,to:j}); nx+=dx; ny+=dy;
          }
        }
      }
      if(spec.mao){
        for(const [dx,dy] of KNIGHT){
          const nx=x+dx, ny=y+dy; if(!inb(nx,ny)) continue;
          const [lx,ly]=legSquare(x,y,dx,dy);
          if(board[IDX(lx,ly)]!=null) continue;
          const j=IDX(nx,ny), q=board[j]; if(q&&q.c===turn) continue;
          moves.push({from:i,to:j});
        }
      }
      if(spec.pawn){
        const df = turn===WHITE?1:-1, fy=y+df;
        if(inb(x,fy)&&board[IDX(x,fy)]==null){
          addPawn(moves,i,IDX(x,fy),fy===promoRank);
          // optional double-step (OFF for current variants; wired behind flag)
          if(spec.pawn.double){
            const startY = turn===WHITE?1:H-2, fy2=y+2*df;
            if(y===startY && inb(x,fy2) && board[IDX(x,fy2)]==null)
              moves.push({from:i,to:IDX(x,fy2),double:true});
          }
        }
        for(const dx of [-1,1]){
          const nx=x+dx; if(!inb(nx,fy)) continue;
          const j=IDX(nx,fy), q=board[j];
          if(q&&q.c!==turn) addPawn(moves,i,j,fy===promoRank);
        }
      }
    }
    if(crazyhouse){
      const hand=hands[turn];
      for(const t of types){
        if(hand[t]<=0) continue;
        const restrict = pieces[t].pawn ? true : false;   // pawn-drop restriction
        for(let j=0;j<board.length;j++){
          if(board[j]!=null) continue;
          if(restrict && YOF(j)===promoRank) continue;
          moves.push({drop:t,to:j});
        }
      }
    }
    return moves;
  }

  function makeMove(state,m){
    const {board,hands,turn}=state, undo={turn,m,cap:null};
    if(m.drop){ board[m.to]={t:m.drop,c:turn,promo:false}; if(crazyhouse) hands[turn][m.drop]--; }
    else{
      const p=board[m.from], q=board[m.to];
      if(q){ undo.cap=q; if(crazyhouse) hands[turn][q.promo?pawnType:q.t]++; }
      board[m.to]=m.promo?{t:m.promo,c:turn,promo:true}:{t:p.t,c:turn,promo:p.promo};
      board[m.from]=null;
    }
    state.turn=1-turn; return undo;
  }
  function unmakeMove(state,undo){
    const {board,hands}=state, turn=undo.turn, m=undo.m; state.turn=turn;
    if(m.drop){ board[m.to]=null; if(crazyhouse) hands[turn][m.drop]++; }
    else{
      const cur=board[m.to];
      if(m.promo) board[m.from]={t:pawnType,c:turn,promo:false};
      else board[m.from]={t:cur.t,c:turn,promo:cur.promo};
      if(undo.cap){ board[m.to]=undo.cap; if(crazyhouse) hands[turn][undo.cap.promo?pawnType:undo.cap.t]--; }
      else board[m.to]=null;
    }
  }

  function legalMoves(state){
    const out=[], turn=state.turn;
    for(const m of pseudoMoves(state)){
      const u=makeMove(state,m);
      if(!inCheck(state.board,turn)) out.push(m);
      unmakeMove(state,u);
    }
    return out;
  }
  function statusOf(state){
    const legal=legalMoves(state);
    if(legal.length) return 'ongoing';
    return inCheck(state.board,state.turn)?'checkmate':'stalemate';
  }
  function key(state){
    let s='';
    for(let i=0;i<state.board.length;i++){
      const p=state.board[i];
      s += p?(p.c===WHITE?p.t:p.t.toLowerCase())+(p.promo?'*':''):'.';
    }
    if(crazyhouse){
      const h=state.hands;
      s+='|'+types.map(t=>h[WHITE][t]).join('')+'/'+types.map(t=>h[BLACK][t]).join('');
    }
    s+='|'+state.turn;
    return s;
  }
  function sameMove(a,b){
    if(!a||!b) return false;
    return a.from===b.from&&a.to===b.to&&a.drop===b.drop&&a.promo===b.promo;
  }

  function perft(state,depth){
    if(depth===0) return 1;
    let n=0;
    for(const m of legalMoves(state)){
      const u=makeMove(state,m);
      n+=perft(state,depth-1);
      unmakeMove(state,u);
    }
    return n;
  }

  return {
    config, W, H, types, WHITE, BLACK, royalType, pawnType,
    IDX, XOF, YOF, inb, KING8,
    initialState, attacked, kingSquare, inCheck,
    pseudoMoves, makeMove, unmakeMove, legalMoves, statusOf, key, sameMove, perft,
  };
}
