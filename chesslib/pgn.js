/* ==================================================================
   chesslib/pgn.js  —  shared, engine-driven variation tree + variant PGN.

   Pure logic, no DOM.  Directly importable in Node.  createPgn(engine)
   returns helpers bound to a variant:

     - sanOf(state,m)            SAN string for a move (matches the UI's).
     - newTree(startState?)      a fresh tree {move,san,parent,children,start}.
     - Node shape: { move, san, parent, children:[...] }.  children[0] is the
       mainline continuation.  The root has move===null and carries `.start`,
       the base position the tree is played from.
     - addMove / navigate / promoteVariation / deleteVariation
     - stateAtNode(node)         replays root.start .. node into a fresh state
                                 (with .history filled for repetition-aware eval).
     - treeFromMoves(moves)      build a tree whose mainline is `moves`.
     - exportPgn(root)           variant-PGN text (headers + recursive variations).
     - importPgn(text)           parse variant-PGN back into a tree.
     - encodePos / decodePos     compact FEN-ish position string for the [Setup].

   SAN matching on import is robust: it generates the legal moves at each
   position and compares their sanOf to the token (trailing +/# stripped),
   so no full SAN grammar is needed.  Handles captures (x), drops (@) and
   promotions (=).
   ================================================================== */

export function createPgn(engine){
  const {
    config, W, H, WHITE, BLACK, IDX, XOF, YOF, pawnType,
    initialState, legalMoves, makeMove, key,
  } = engine;
  const PIECE = config.pieces;
  const TYPES = config.types;
  const fileLetters = config.fileLetters;
  const sqName = j => fileLetters[XOF(j)] + (YOF(j) + 1);

  /* ---- SAN (identical to the UI's historical sanOf) ---- */
  function sanOf(state, m){
    const p = m.drop ? { t: m.drop } : state.board[m.from];
    if(m.drop) return PIECE[m.drop].letter + '@' + sqName(m.to);
    const cap = state.board[m.to] != null;
    let s = (p.t === pawnType ? '' : PIECE[p.t].letter) + sqName(m.from) + (cap ? 'x' : '-') + sqName(m.to);
    if(m.promo) s += '=' + PIECE[m.promo].letter;
    return s;
  }
  const normSan = s => s.replace(/[+#]+$/, '');

  /* ---- state cloning / replay ---- */
  function cloneState(s){
    return {
      board: s.board.map(p => p ? { t:p.t, c:p.c, promo:p.promo } : null),
      hands: [ { ...s.hands[WHITE] }, { ...s.hands[BLACK] } ],
      turn: s.turn, history: [],
    };
  }
  function pathTo(node){ const p=[]; let n=node; while(n){ p.unshift(n); n=n.parent; } return p; }
  function rootOf(node){ let n=node; while(n.parent) n=n.parent; return n; }
  function depthOf(node){ let d=0,n=node; while(n.parent){ d++; n=n.parent; } return d; }
  function stateAtNode(node){
    const root = rootOf(node);
    const s = cloneState(root.start);
    const hist = [ key(s) ];
    for(const nd of pathTo(node)){ if(nd.move){ makeMove(s, nd.move); hist.push(key(s)); } }
    s.history = hist;
    return s;
  }

  /* ---- tree construction / editing ---- */
  function newTree(startState){
    const root = { move:null, san:null, parent:null, children:[] };
    root.start = startState ? cloneState(startState) : initialState();
    return root;
  }
  function sameMove(a, b){
    if(!a || !b) return false;
    return a.from===b.from && a.to===b.to && a.drop===b.drop && a.promo===b.promo;
  }
  // Add move `m` at `node` (whose position is `state`); reuse an existing child
  // if the same move is already there, else create a new variation.
  function addMove(node, m, state){
    const existing = node.children.find(c => sameMove(c.move, m));
    if(existing) return existing;
    const child = { move:m, san: sanOf(state, m), parent:node, children:[] };
    node.children.push(child);
    return child;
  }
  function promoteVariation(node){
    const p = node.parent; if(!p) return;
    const i = p.children.indexOf(node);
    if(i > 0){ p.children.splice(i, 1); p.children.unshift(node); }
  }
  function deleteVariation(node){
    const p = node.parent; if(!p) return p ? node : null;
    const i = p.children.indexOf(node);
    if(i >= 0) p.children.splice(i, 1);
    return p; // caller should navigate to parent
  }
  function treeFromMoves(moveList, startState){
    const root = newTree(startState);
    const s = cloneState(root.start);
    let node = root;
    for(const m of moveList){
      const child = { move:m, san: sanOf(s, m), parent:node, children:[] };
      node.children.push(child); makeMove(s, m); node = child;
    }
    return { root, end: node };
  }

  /* ---- compact position string (FEN-ish) for [Setup] ---- */
  function encodePos(state){
    const ranks = [];
    for(let y=H-1; y>=0; y--){
      let row=''; let empt=0;
      for(let x=0; x<W; x++){
        const p = state.board[IDX(x,y)];
        if(!p){ empt++; continue; }
        if(empt){ row += empt; empt=0; }
        row += (p.c===WHITE ? p.t : p.t.toLowerCase()) + (p.promo ? '~' : '');
      }
      if(empt) row += empt;
      ranks.push(row);
    }
    const side = state.turn===WHITE ? 'w' : 'b';
    let hand='';
    for(const c of [WHITE,BLACK]) for(const t of TYPES){
      const n = state.hands[c][t]; for(let k=0;k<n;k++) hand += (c===WHITE ? t : t.toLowerCase());
    }
    return ranks.join('/') + ' ' + side + ' ' + (hand || '-');
  }
  function decodePos(str){
    const parts = str.trim().split(/\s+/);
    const boardPart = parts[0], side = parts[1] || 'w', hand = parts[2] || '-';
    const s = initialState();
    s.board.fill(null);
    for(const t of TYPES){ s.hands[WHITE][t]=0; s.hands[BLACK][t]=0; }
    const rows = boardPart.split('/');
    for(let r=0; r<rows.length; r++){
      const y = H-1-r; let x=0; const row = rows[r];
      for(let ci=0; ci<row.length; ci++){
        const ch = row[ci];
        if(/[0-9]/.test(ch)){ x += parseInt(ch,10); continue; }
        const promo = row[ci+1]==='~';
        const isWhite = ch === ch.toUpperCase();
        s.board[IDX(x,y)] = { t: ch.toUpperCase(), c: isWhite?WHITE:BLACK, promo };
        if(promo) ci++;
        x++;
      }
    }
    s.turn = side==='b' ? BLACK : WHITE;
    if(hand && hand!=='-'){
      for(const ch of hand){
        const isWhite = ch===ch.toUpperCase();
        s.hands[isWhite?WHITE:BLACK][ch.toUpperCase()]++;
      }
    }
    s.history = [];
    return s;
  }

  /* ---- export ---- */
  function movesRec(node, depth, needNum){
    if(!node.children.length) return '';
    const main = node.children[0];
    const white = depth%2===0, num = Math.floor(depth/2)+1;
    let s = white ? (num+'. ') : (needNum ? (num+'... ') : '');
    s += main.san + ' ';
    let hadVar = false;
    for(let i=1; i<node.children.length; i++){
      hadVar = true;
      s += '(' + varRec(node.children[i], depth) + ') ';
    }
    s += movesRec(main, depth+1, hadVar);
    return s;
  }
  function varRec(node, depth){
    const white = depth%2===0, num = Math.floor(depth/2)+1;
    let s = white ? (num+'. ') : (num+'... ');
    s += node.san + ' ';
    s += movesRec(node, depth+1, false);
    return s.trim();
  }
  function exportPgn(root){
    const header =
      `[Event "Analysis"]\n` +
      `[Variant "${config.title}"]\n` +
      `[Result "*"]\n` +
      `[Setup "${encodePos(root.start)}"]\n`;
    const body = movesRec(root, 0, false).trim();
    return header + '\n' + (body ? body + ' *' : '*') + '\n';
  }

  /* ---- import ---- */
  function importPgn(text){
    const headers = {};
    const hdrRe = /\[(\w+)\s+"([^"]*)"\]/g; let mt;
    while((mt = hdrRe.exec(text))) headers[mt[1]] = mt[2];
    let body = text.replace(/\[[^\]]*\]/g, ' ')      // strip header tags
                   .replace(/\{[^}]*\}/g, ' ')       // strip comments
                   .replace(/;[^\n]*/g, ' ')         // strip line comments
                   .replace(/\$\d+/g, ' ');          // strip NAGs
    const tokens = body.match(/\(|\)|[^\s()]+/g) || [];
    const setupStr = headers.Setup || headers.FEN;
    const startState = setupStr ? decodePos(setupStr) : initialState();
    const root = newTree(startState);
    let current = root; const stack = [];
    const stateAt = node => stateAtNode(node);
    for(const tk of tokens){
      if(tk === '('){
        if(!current.parent) throw new Error('PGN: variation with no preceding move');
        stack.push(current); current = current.parent; continue;
      }
      if(tk === ')'){
        if(!stack.length) throw new Error('PGN: unbalanced ")"');
        current = stack.pop(); continue;
      }
      if(/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tk)) continue;
      const san = normSan(tk.replace(/^\d+\.+/, ''));
      if(san === '') continue;                       // was a bare move number
      const S = stateAt(current);
      const legal = legalMoves(S);
      let matched = null;
      for(const m of legal){ if(normSan(sanOf(S, m)) === san){ matched = m; break; } }
      if(!matched) throw new Error('PGN: unrecognized move "' + tk + '"');
      current = addMove(current, matched, S);
    }
    return { root, headers };
  }

  return {
    sanOf, normSan, cloneState, pathTo, rootOf, depthOf, stateAtNode,
    newTree, sameMove, addMove, promoteVariation, deleteVariation, treeFromMoves,
    encodePos, decodePos, exportPgn, importPgn,
  };
}
