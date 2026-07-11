/* ==================================================================
   chesslib/ui.js  —  the browser UI, wired to a variant config.

   Two tabs:
     • Play      — the game (You-play / Opponent / New game / Undo /
                   Analyze game), board, hands, status, move list, bot.
     • Analysis  — a full analysis board interactive for BOTH sides:
                   eval bar, engine multi-PV lines, a real VARIATION TREE
                   (branch / navigate / promote-to-mainline / delete),
                   navigation, and variant-PGN import / export.

   The board area is shared and re-rendered per active tab; switching tabs
   never disturbs the live game.  boot(config, mount) builds the DOM,
   injects the shared CSS, creates the engine + search + pgn helpers from
   the config, and starts a new game.
   ================================================================== */
import { createEngine, WHITE, BLACK } from './engine.js';
import { createSearch } from './search.js';
import { createPgn } from './pgn.js';
import { pieceSVG } from './pieces.js';
import { CSS } from './styles.js';

const STALEMATE_HTML =
  '<strong>Stalemate rule:</strong> if it\'s your turn and you have <em>no</em> legal move but you\'re <em>not</em> in check, <strong>you win</strong>. So you can never win by stalemating your opponent — you must always leave them a move, or you lose. (Being checkmated — no move <em>while</em> in check — is still a loss.)';

export function boot(config, mount){
  const engine = createEngine(config);
  const search = createSearch(engine);
  const pgn = createPgn(engine);
  const {
    W, H, IDX, XOF, YOF, inb, kingSquare, initialState, inCheck,
    legalMoves, makeMove, unmakeMove, statusOf, key,
  } = engine;
  const { WEIGHTS, LEVELS, OPENING_PLIES, searchMove, analyze, pickOpeningMove } = search;
  const { sanOf, stateAtNode, depthOf } = pgn;
  const MATE = WEIGHTS.MATE;
  const TYPES = config.types;
  const PIECE = config.pieces;
  const pieceMarkup = (t,c)=>pieceSVG(t,c);
  const promoRankOf = turn=>turn===WHITE?H-1:0;

  // ---- inject CSS once ----
  if(!document.getElementById('chesslib-css')){
    const st=document.createElement('style'); st.id='chesslib-css'; st.textContent=CSS;
    document.head.appendChild(st);
  }
  document.title = config.title;

  // ---- build markup ----
  const mountEl = typeof mount==='string' ? document.querySelector(mount) : mount;
  mountEl.innerHTML = `
<div class="wrap">
  <div class="titlerow">
    <h1>${config.title}</h1>
    <button class="help-btn" id="helpBtn" title="How to play">?</button>
  </div>
  <div class="tagline">${config.tagline}</div>

  <div class="tabs">
    <button class="tab active" id="tabPlay">Play</button>
    <button class="tab" id="tabAnalysis">Analysis</button>
  </div>

  <div id="playPanel">
    <div class="card controls">
      <label>You play</label>
      <select id="side"><option value="alt" selected>Alternate</option><option value="0">White (bottom)</option><option value="1">Black (top)</option></select>
      <label>Opponent</label>
      <select id="opp">
        <option value="human">Human</option>
        <option value="easy">Bot · Easy</option>
        <option value="medium" selected>Bot · Medium</option>
        <option value="hard">Bot · Hard</option>
        <option value="insane">Bot · Insane</option>
      </select>
      <button class="primary" id="newgame">New game</button>
      <button id="undo">Undo</button>
      <button id="analyzeGame">Analyze game</button>
    </div>
  </div>

  <div id="analysisPanel" hidden>
    <div class="card controls">
      <button class="primary" id="anNew">New</button>
      <button id="anImport">Import PGN</button>
      <button id="anExport">Export PGN</button>
    </div>
  </div>

  <div class="status" id="status"></div>

  <div class="card">
    <div class="hand" id="handTop"></div>
    <div class="boardwrap">
      <div class="evalbar" id="evalbar" hidden><div class="fill" id="evalfill"></div><span class="num top" id="evalNumTop"></span><span class="num bot" id="evalNumBot"></span></div>
      <div class="board" id="board"></div>
    </div>
    <div class="hand" id="handBot"></div>
    <div class="promoPick" id="promoPick" style="display:none"></div>
  </div>

  <div class="card analyze-card" id="analyzeCard" hidden>
    <div class="anhint">Play moves for either side to explore lines. Step with ⏮ ◀ ▶ ⏭ or ← →. Playing a move from an earlier point starts a new <em>variation</em> instead of overwriting.</div>
    <div class="navrow">
      <button id="navStart" title="First">⏮</button>
      <button id="navPrev" title="Back">◀</button>
      <span class="navlbl" id="navlbl">start</span>
      <button id="navNext" title="Forward">▶</button>
      <button id="navEnd" title="Latest">⏭</button>
    </div>
    <div class="analysis" id="analysis"></div>
    <div class="tree" id="tree"></div>
    <div class="treeops">
      <button id="btnPromote" title="Make this variation the mainline">Promote to mainline</button>
      <button id="btnDelete" title="Delete this variation">Delete variation</button>
    </div>
  </div>

  <div class="card" id="moveListCard">
    <details><summary>Move list</summary><div class="moves" id="moves"></div></details>
  </div>
</div>

<div class="modal-bg" id="helpModal">
  <div class="modal-box">
    <button class="close" id="helpClose">×</button>
    <h2>${config.help.title}</h2>
    <p>${config.help.intro}</p>
    <p>${STALEMATE_HTML}</p>
    <p>${config.help.setupLine}</p>
    <h2>How the pieces move</h2>
    <div class="legend" id="legend"></div>
    <p style="margin-top:10px">${config.help.dropsLine}</p>
  </div>
</div>

<div class="modal-bg" id="pgnModal">
  <div class="modal-box">
    <button class="close" id="pgnClose">×</button>
    <h2>Variant PGN</h2>
    <textarea class="pgnarea" id="pgnText" spellcheck="false" placeholder="Paste PGN here and press Import, or export the current tree…"></textarea>
    <div class="pgnerr" id="pgnErr"></div>
    <div class="pgnbtns">
      <button id="pgnCopy">Copy</button>
      <button id="pgnDownload">Download</button>
      <button class="primary" id="pgnImport">Import</button>
    </div>
  </div>
</div>`;

  const $=id=>document.getElementById(id);
  const board=$('board');
  board.style.gridTemplateColumns=`repeat(${W},1fr)`;
  board.style.gridTemplateRows=`repeat(${H},1fr)`;

  // ---- state ----
  let state, humanSide=WHITE, oppMode='medium', posCount={}, moveLog=[], busy=false, altSide=WHITE;
  let sel=null;         // {type:'sq',i} or {type:'hand',pt}
  let legalCache=[];
  let pendingPromo=null;
  let activeTab='play', analyzeMode=false;
  let dstate=null, analysisData=null, analysisToken=0;
  // variation tree
  let treeRoot=pgn.newTree(), curNode=treeRoot;

  function newGame(){
    state=initialState();
    const sv=$('side').value;
    if(sv==='alt'){ humanSide=altSide; altSide=1-altSide; } else humanSide=parseInt(sv,10);
    oppMode=$('opp').value;
    posCount={}; moveLog=[]; sel=null; pendingPromo=null; busy=false;
    bumpPos(); render();
    maybeBotMove();
  }
  function bumpPos(){const k=key(state);posCount[k]=(posCount[k]||0)+1;state.history=Object.keys(posCount).flatMap(kk=>Array(posCount[kk]).fill(kk));}
  function threefold(){return posCount[key(state)]>=3;}

  function render(){
    dstate = analyzeMode ? stateAtNode(curNode) : state;
    legalCache = dstate ? legalMoves(dstate) : [];
    renderBoard(); renderHands(); renderStatus(); renderMoves(); renderPromo();
    renderAnalyzeUI();
  }
  function orientedIndices(){
    const idxs=[];
    const topDown = humanSide===WHITE; // white at bottom -> render top rank first
    for(let r=0;r<H;r++){const y=topDown?H-1-r:r;for(let c=0;c<W;c++){const x=topDown?c:W-1-c;idxs.push(IDX(x,y));}}
    return idxs;
  }
  function renderBoard(){
    board.innerHTML='';
    const S=dstate;
    const chkSq = S && inCheck(S.board,S.turn) ? kingSquare(S.board,S.turn) : -1;
    const last = analyzeMode ? (curNode.move||null)
                             : (moveLog.length?moveLog[moveLog.length-1].m:null);
    for(const i of orientedIndices()){
      const x=XOF(i),y=YOF(i);const d=document.createElement('div');
      d.className='sqr '+(((x+y)%2===0)?'d':'l'); d.dataset.i=i;
      // rank number label only along the left edge column
      if(x===(humanSide===WHITE?0:W-1)) {const c=document.createElement('span');c.className='coord';c.textContent=(y+1);d.appendChild(c);}
      if(i===chkSq)d.classList.add('incheck');
      if(last){if(!last.drop&&last.from===i)d.classList.add('lastfrom');if(last.to===i)d.classList.add('lastto');}
      if(sel){
        if(sel.type==='sq'&&sel.i===i)d.classList.add('sel');
        const tmoves=currentTargets();
        const t=tmoves.find(m=>m.to===i);
        if(t){const cap=!t.drop&&S.board[i]!=null;d.classList.add('tgt');if(cap)d.classList.add('tgtcap');}
      }
      const p=S.board[i];
      if(p){const tok=document.createElement('div');tok.className='tok '+(p.c===WHITE?'wc':'bc')+(p.promo?' promo':'');
        const lg=document.createElement('div');lg.className='lg';lg.innerHTML=pieceMarkup(p.t,p.c);
        tok.appendChild(lg);d.appendChild(tok);}
      d.onclick=()=>onSquare(i);
      board.appendChild(d);
    }
  }
  function currentTargets(){
    if(!sel)return[];
    if(sel.type==='sq')return legalCache.filter(m=>!m.drop&&m.from===sel.i);
    return legalCache.filter(m=>m.drop===sel.pt);
  }
  function renderHands(){
    const topColor = humanSide===WHITE?BLACK:WHITE;
    fillHand($('handTop'),topColor);
    fillHand($('handBot'),1-topColor);
  }
  function fillHand(el,color){
    el.innerHTML='';
    const who=document.createElement('div');who.className='who';
    who.textContent=(color===WHITE?'White':'Black')+' hand'+(!analyzeMode&&color===humanSide?' (you)':'');
    el.appendChild(who);
    const h=dstate.hands[color];
    let any=false;
    for(const t of TYPES){
      const n=h[t];
      const tok=document.createElement('div');
      tok.className='htok '+(color===WHITE?'wc':'bc')+(n<=0?' empty':'');
      const ic=document.createElement('div');ic.className='hicon';ic.innerHTML=pieceMarkup(t,color);
      tok.appendChild(ic);
      if(n>0){const c=document.createElement('span');c.className='cnt';c.textContent=n;tok.appendChild(c);any=true;}
      if(sel&&sel.type==='hand'&&sel.pt===t&&color===dstate.turn)tok.classList.add('sel');
      if(n>0&&color===dstate.turn&&(analyzeMode?statusOf(dstate)==='ongoing':isHumanTurn()))tok.onclick=()=>onHand(t);
      el.appendChild(tok);
    }
  }
  function renderStatus(){
    const el=$('status');const S=dstate;const st=statusOf(S);
    const sideName=c=>c===WHITE?'White':'Black';
    if(st==='checkmate'){el.innerHTML=`<span class="check">Checkmate — ${sideName(1-S.turn)} wins.</span>`;return;}
    if(st==='stalemate'){el.innerHTML=`<span class="check">Stalemate — ${sideName(S.turn)} wins!</span>`;return;}
    if(!analyzeMode&&threefold()){el.innerHTML=`Draw by threefold repetition.`;return;}
    let s='';
    if(analyzeMode)s+=`<span class="think">Analysis · </span>`;
    if(inCheck(S.board,S.turn))s+=`<span class="check">Check! </span>`;
    s+=`${sideName(S.turn)} to move`;
    if(!analyzeMode&&!isHumanTurn())s+=` <span class="think">— bot thinking…</span>`;
    el.innerHTML=s;
  }
  function renderMoves(){
    const el=$('moves');
    el.innerHTML=moveLog.map((e,i)=>{
      const num=(i%2===0)?`<b>${(i/2|0)+1}.</b> `:'';
      return `${num}<span class="mv" data-ply="${i+1}">${e.san}</span> `;
    }).join('')||'<span style="opacity:.6">No moves yet.</span>';
    el.scrollTop=el.scrollHeight;
  }
  function renderPromo(){
    const el=$('promoPick');
    if(!pendingPromo){el.style.display='none';el.innerHTML='';return;}
    el.innerHTML='';el.style.display='flex';
    const box=document.createElement('div');box.className='promoBox';
    const t=document.createElement('div');t.className='ttl';t.textContent='Promote to';box.appendChild(t);
    const mover=dstate.turn;
    for(const pt of config.promoUiOrder){
      const b=document.createElement('button');
      b.innerHTML='<span class="pmini">'+pieceMarkup(pt,mover)+'</span>'+PIECE[pt].name;
      b.onclick=()=>{const m=pendingPromo.options.find(o=>o.promo===pt);pendingPromo=null;(analyzeMode?analyzeMove:doMove)(m);};
      box.appendChild(b);
    }
    el.appendChild(box);
  }
  function isHumanTurn(){return oppMode==='human'||state.turn===humanSide;}

  /* ---------------- tabs ---------------- */
  function setTab(tab){
    activeTab=tab; analyzeMode=(tab==='analysis');
    $('tabPlay').classList.toggle('active',tab==='play');
    $('tabAnalysis').classList.toggle('active',tab==='analysis');
    $('playPanel').hidden = tab!=='play';
    $('analysisPanel').hidden = tab!=='analysis';
    $('analyzeCard').hidden = tab!=='analysis';
    $('moveListCard').hidden = tab!=='play';
    sel=null; pendingPromo=null;
    if(analyzeMode){ render(); startAnalysis(); }
    else { stopAnalysis(); render(); }
  }

  /* ---------------- variation tree ---------------- */
  function goToNode(n){
    curNode=n; if(n.parent) n.parent._last=n;
    sel=null; pendingPromo=null; render(); startAnalysis();
  }
  function navBack(){ if(curNode.parent) goToNode(curNode.parent); }
  function navFwd(){
    if(!curNode.children.length) return;
    const n=(curNode._last&&curNode.children.includes(curNode._last))?curNode._last:curNode.children[0];
    goToNode(n);
  }
  function navFirst(){ goToNode(treeRoot); }
  function navLast(){
    let n=curNode;
    while(n.children.length){ n=(n._last&&n.children.includes(n._last))?n._last:n.children[0]; }
    goToNode(n);
  }
  function analyzeMove(m){
    const S=dstate;                       // position at curNode
    const child=pgn.addMove(curNode,m,S); // reuse existing or branch a new variation
    goToNode(child);
  }
  function promoteCur(){ if(curNode.parent){ pgn.promoteVariation(curNode); render(); } }
  function deleteCur(){ if(curNode.parent){ const p=curNode.parent; pgn.deleteVariation(curNode); goToNode(p); } }

  function analyzeGame(){
    const built=pgn.treeFromMoves(moveLog.map(e=>e.m));
    treeRoot=built.root; curNode=built.end; curNode._fromEnd=true;
    setTab('analysis');
  }
  function newAnalysis(){
    treeRoot=pgn.newTree(); curNode=treeRoot;
    sel=null; pendingPromo=null; render(); startAnalysis();
  }

  // tree rendering (PGN-style, mainline inline + variations in parens)
  let treeSeq=0, treeMap={};
  function mvSpan(node){
    const id=++treeSeq; treeMap[id]=node;
    const cur=node===curNode?' cur':'';
    return `<span class="tmv${cur}" data-n="${id}">${node.san}</span>`;
  }
  function treeMoves(node,depth,needNum){
    if(!node.children.length) return '';
    const main=node.children[0];
    const white=depth%2===0, num=Math.floor(depth/2)+1;
    let s = white?`<span class="mvn">${num}.</span> `:(needNum?`<span class="mvn">${num}…</span> `:'');
    s+=mvSpan(main)+' ';
    let hadVar=false;
    for(let i=1;i<node.children.length;i++){ hadVar=true; s+=`<span class="var">(${treeVar(node.children[i],depth)})</span> `; }
    s+=treeMoves(main,depth+1,hadVar);
    return s;
  }
  function treeVar(node,depth){
    const white=depth%2===0, num=Math.floor(depth/2)+1;
    let s = white?`<span class="mvn">${num}.</span> `:`<span class="mvn">${num}…</span> `;
    s+=mvSpan(node)+' ';
    s+=treeMoves(node,depth+1,false);
    return s.trim();
  }
  function renderTree(){
    const el=$('tree'); treeMap={}; treeSeq=0;
    const html=treeMoves(treeRoot,0,false);
    el.innerHTML=html||'<span class="empty">No moves yet — play a move on the board to start a line.</span>';
    el.querySelectorAll('.tmv').forEach(sp=>sp.onclick=()=>{ const n=treeMap[sp.dataset.n]; if(n) goToNode(n); });
    const isVar=!!(curNode.parent&&curNode.parent.children.indexOf(curNode)>0);
    $('btnPromote').disabled=!isVar;
    $('btnDelete').disabled=!curNode.parent;
  }

  /* ---------------- analysis engine ---------------- */
  function stopAnalysis(){ analysisToken++; analysisData=null; }
  function startAnalysis(){
    if(!analyzeMode) return;
    const token=++analysisToken;
    const S=stateAtNode(curNode);
    const status=statusOf(S);
    if(status!=='ongoing'){ analysisData={depth:0,lines:[],turn:S.turn,terminal:status,base:S}; renderEvalBar(); renderAnalysis(); return; }
    analysisData={depth:0,lines:[],turn:S.turn,terminal:null,base:S};
    const MAXD=8; let d=1;
    const step=()=>{
      if(token!==analysisToken) return;
      const t0=performance.now();
      const r=analyze(S,d,3,S.history);
      if(token!==analysisToken) return;
      analysisData={depth:d,lines:r.lines,turn:S.turn,terminal:null,base:S,nodes:r.nodes};
      renderEvalBar(); renderAnalysis();
      const dt=performance.now()-t0;
      const mate=r.lines.length&&Math.abs(r.lines[0].score)>MATE-100;
      if(d<MAXD && !mate && dt<900){ d++; setTimeout(step,16); }
    };
    setTimeout(step,16);
  }
  function whiteEvalCp(){
    if(!analysisData)return null;
    if(analysisData.terminal){
      const mover=analysisData.turn;
      const moverWins = analysisData.terminal==='stalemate';
      const cp = moverWins ? MATE : -MATE;
      return mover===WHITE?cp:-cp;
    }
    if(!analysisData.lines.length)return null;
    const sc=analysisData.lines[0].score;
    return analysisData.turn===WHITE?sc:-sc;
  }
  function evalLabel(cp){
    if(cp==null)return '';
    if(Math.abs(cp)>MATE-100){ const n=Math.max(1,Math.ceil((MATE-Math.abs(cp))/2)); return (cp>0?'M':'-M')+n; }
    return (cp>0?'+':'')+(cp/100).toFixed(1);
  }
  function renderEvalBar(){
    const bar=$('evalbar'); bar.hidden=!analyzeMode; if(!analyzeMode)return;
    const cp=whiteEvalCp();
    let p=0.5;
    if(cp!=null){ if(Math.abs(cp)>MATE-100) p=cp>0?1:0; else p=1/(1+Math.pow(10,-cp/400)); }
    const bottomIsWhite = humanSide===WHITE;
    const fill=$('evalfill');
    fill.style.height=(100*p)+'%';
    if(bottomIsWhite){ fill.style.bottom='0'; fill.style.top='auto'; }
    else { fill.style.top='0'; fill.style.bottom='auto'; }
    const lab=cp==null?'':evalLabel(cp);
    $('evalNumTop').textContent=bottomIsWhite?'':lab;
    $('evalNumBot').textContent=bottomIsWhite?lab:'';
  }
  function pvToSan(baseState,pv,maxShow){
    const S=baseState,undos=[],out=[];
    let mvNo=Math.floor(depthOf(curNode)/2)+1,white=(S.turn===WHITE);
    for(let i=0;i<pv.length&&i<(maxShow||99);i++){
      const m=pv[i];
      const pre=white?`${mvNo}.`:(i===0?`${mvNo}…`:'');
      out.push(pre+sanOf(S,m));
      undos.push(makeMove(S,m));
      if(!white)mvNo++; white=!white;
    }
    for(let i=undos.length-1;i>=0;i--)unmakeMove(S,undos[i]);
    return out.join(' ');
  }
  function renderAnalysis(){
    const el=$('analysis'); if(!analyzeMode)return;
    const A=analysisData;
    if(!A){el.innerHTML='<div class="head">Starting engine…</div>';return;}
    if(A.terminal){ const w=A.turn===WHITE?'White':'Black',b=A.turn===WHITE?'Black':'White';
      const msg=A.terminal==='checkmate'?`Checkmate — ${b} wins`:A.terminal==='stalemate'?`Stalemate — ${w} wins`:'Game over';
      el.innerHTML=`<div class="head">${msg}</div>`; return; }
    const cp=whiteEvalCp();
    let h=`<div class="head">Depth ${A.depth||'…'}${A.nodes?` · ${(A.nodes/1000|0)}k nodes`:''}${cp!=null?` · <b>${evalLabel(cp)}</b>`:''}</div>`;
    h+=(A.lines||[]).map(ln=>{
      const wcp=A.turn===WHITE?ln.score:-ln.score;
      const cls=wcp>20?'pos':(wcp<-20?'neg':'');
      return `<div class="ln"><span class="sc ${cls}">${evalLabel(wcp)}</span><span class="pv">${pvToSan(A.base,ln.pv,8)}</span></div>`;
    }).join('');
    el.innerHTML=h;
  }
  function renderAnalyzeUI(){
    $('analyzeCard').hidden=!analyzeMode;
    if(analyzeMode){
      const d=depthOf(curNode);
      $('navlbl').textContent = d===0?'start':(curNode.children.length?`move ${d}`:`end (${d})`);
      renderEvalBar(); renderAnalysis(); renderTree();
    } else { $('evalbar').hidden=true; }
  }

  function onSquare(i){
    if(pendingPromo)return;
    const S=dstate;
    if(analyzeMode){ if(statusOf(S)!=='ongoing')return; }
    else { if(busy)return; if(statusOf(state)!=='ongoing'||threefold())return; if(!isHumanTurn())return; }
    const apply=analyzeMode?analyzeMove:doMove;
    if(sel&&sel.type==='hand'){
      const m=legalCache.find(mm=>mm.drop===sel.pt&&mm.to===i);
      if(m){sel=null;apply(m);return;}
      sel=null;render();return;
    }
    const p=S.board[i];
    if(sel&&sel.type==='sq'){
      const cand=legalCache.filter(m=>!m.drop&&m.from===sel.i&&m.to===i);
      if(cand.length){
        if(cand.length>1&&cand[0].promo){pendingPromo={options:cand};sel=null;render();return;}
        const m=cand[0];sel=null;apply(m);return;
      }
    }
    if(sel&&sel.type==='sq'&&sel.i===i){sel=null;render();return;}
    if(p&&p.c===S.turn){sel={type:'sq',i};render();return;}
    sel=null;render();
  }
  function onHand(pt){
    if(pendingPromo)return;
    if(analyzeMode){ if(statusOf(dstate)!=='ongoing')return; }
    else { if(busy||!isHumanTurn())return; }
    sel=(sel&&sel.type==='hand'&&sel.pt===pt)?null:{type:'hand',pt};
    render();
  }
  function doMove(m){
    const san=sanOf(state,m);
    makeMove(state,m);
    moveLog.push({m,san});
    bumpPos();
    sel=null;
    render();
    const st=statusOf(state);
    if(st==='ongoing'&&!threefold()) maybeBotMove();
  }
  function maybeBotMove(){
    if(oppMode==='human')return;
    if(state.turn===humanSide)return;
    const st=statusOf(state);if(st!=='ongoing'||threefold())return;
    busy=true;renderStatus();
    setTimeout(()=>{
      const lvl=LEVELS[oppMode];
      let move;
      const legal=legalMoves(state);
      if(lvl.blunder>0&&Math.random()<lvl.blunder){
        move=legal[Math.floor(Math.random()*legal.length)];
      }else if(moveLog.length<OPENING_PLIES){
        move=pickOpeningMove(state,lvl,state.history)||searchMove(state,{maxDepth:lvl.maxDepth,timeMs:lvl.timeMs,history:state.history}).move||legal[0];
      }else{
        const res=searchMove(state,{maxDepth:lvl.maxDepth,timeMs:lvl.timeMs,history:state.history});
        move=res.move||legal[0];
      }
      const san=sanOf(state,move);
      makeMove(state,move);moveLog.push({m:move,san});bumpPos();
      busy=false;render();
    },30);
  }
  function undo(){
    if(busy||moveLog.length===0)return;
    const drop=(oppMode!=='human')?Math.min(2,moveLog.length):1;
    const keep=moveLog.slice(0,moveLog.length-drop);
    state=initialState();posCount={};moveLog=[];bumpPos();
    for(const e of keep){makeMove(state,e.m);moveLog.push(e);bumpPos();}
    sel=null;pendingPromo=null;busy=false;render();
  }

  /* ---------------- PGN modal ---------------- */
  function showPgn(){ $('pgnModal').style.display='flex'; }
  function hidePgn(){ $('pgnModal').style.display='none'; }
  function openExport(){ $('pgnErr').textContent=''; $('pgnText').value=pgn.exportPgn(treeRoot); showPgn(); }
  function openImport(){ $('pgnErr').textContent=''; $('pgnText').value=''; showPgn(); $('pgnText').focus(); }
  function doImport(){
    try{
      const {root}=pgn.importPgn($('pgnText').value);
      treeRoot=root; let n=root; while(n.children.length) n=n.children[0]; curNode=n;
      hidePgn();
      if(analyzeMode){ render(); startAnalysis(); } else setTab('analysis');
    }catch(e){ $('pgnErr').textContent=(e&&e.message)||String(e); }
  }
  function pgnDownload(){
    const blob=new Blob([$('pgnText').value],{type:'text/plain'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=(config.id||'game')+'-analysis.pgn';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }
  function pgnCopy(){
    const ta=$('pgnText'); ta.select();
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).catch(()=>{});
    else { try{document.execCommand('copy');}catch(e){} }
  }

  /* ---- legend ---- */
  (function legend(){
    const el=$('legend');
    el.innerHTML = config.legend.map(([t,n,d])=>`<div class="row"><span class="chip">${pieceMarkup(t,WHITE)}</span><span><b>${n}</b> — ${d}</span></div>`).join('');
  })();

  /* ---- help modal ---- */
  (function(){
    const modal=$('helpModal');
    $('helpBtn').onclick=()=>{modal.style.display='flex';};
    $('helpClose').onclick=()=>{modal.style.display='none';};
    modal.onclick=e=>{if(e.target===modal)modal.style.display='none';};
  })();

  /* ---- wire up ---- */
  $('newgame').onclick=newGame;
  $('undo').onclick=undo;
  $('side').onchange=newGame;
  $('opp').onchange=newGame;
  $('analyzeGame').onclick=analyzeGame;
  $('tabPlay').onclick=()=>setTab('play');
  $('tabAnalysis').onclick=()=>setTab('analysis');
  $('anNew').onclick=newAnalysis;
  $('anImport').onclick=openImport;
  $('anExport').onclick=openExport;
  $('btnPromote').onclick=promoteCur;
  $('btnDelete').onclick=deleteCur;
  $('navStart').onclick=navFirst;
  $('navPrev').onclick=navBack;
  $('navNext').onclick=navFwd;
  $('navEnd').onclick=navLast;
  $('pgnClose').onclick=hidePgn;
  $('pgnImport').onclick=doImport;
  $('pgnCopy').onclick=pgnCopy;
  $('pgnDownload').onclick=pgnDownload;
  (function(){ const m=$('pgnModal'); m.onclick=e=>{if(e.target===m)hidePgn();}; })();
  document.addEventListener('keydown',e=>{
    if(!analyzeMode)return;
    const tag=(e.target&&e.target.tagName)||'';
    if(tag==='TEXTAREA'||tag==='INPUT')return;
    if(e.key==='ArrowLeft'){navBack();e.preventDefault();}
    else if(e.key==='ArrowRight'){navFwd();e.preventDefault();}
    else if(e.key==='Home'){navFirst();e.preventDefault();}
    else if(e.key==='End'){navLast();e.preventDefault();}
  });
  newGame();
}
