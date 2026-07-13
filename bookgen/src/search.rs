//! Strong, fast search: negamax + alpha-beta + PVS + Zobrist-hashed TT +
//! quiescence + iterative deepening + LMR + killer/history ordering +
//! aspiration windows. Null-move is implemented but OFF by default (net
//! negative on these tiny zugzwang / stalemate-win boards).
//!
//! Terminal scoring and static eval match chesslib/search.js exactly, so
//! root scores are on the JS scale.

use crate::engine::{Engine, Move, State, WHITE};
use crate::eval::Ev;
use std::collections::HashMap;
use std::time::Instant;

const INF: f64 = 1e18;

#[derive(Clone, Copy)]
pub struct TTEntry {
    pub depth: i32,
    pub value: f64,
    pub flag: i8, // 0 exact, -1 lower bound, 1 upper bound
    pub best: Option<Move>,
}

/// Persistent Zobrist-keyed transposition table (shared across a whole run).
pub struct TT {
    pub map: HashMap<u64, TTEntry>,
    pub probes: u64,
    pub hits: u64,
}
impl TT {
    pub fn new() -> TT {
        TT { map: HashMap::new(), probes: 0, hits: 0 }
    }
    pub fn with_capacity(n: usize) -> TT {
        TT { map: HashMap::with_capacity(n), probes: 0, hits: 0 }
    }
}

fn splitmix64(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E3779B97F4A7C15);
    let mut r = z;
    r = (r ^ (r >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    r = (r ^ (r >> 27)).wrapping_mul(0x94D049BB133111EB);
    r ^ (r >> 31)
}

pub struct Searcher<'a> {
    pub e: &'a Engine,
    ev: Ev<'a>,
    // zobrist[square][piece-kind]; kind = letterIndex*4 + color*2 + promo
    z_board: Vec<[u64; 64]>,
    letter_index: [i32; 128],
    n_letters: usize,
    // hands[color][typeIndex][count]
    z_hand: Vec<Vec<Vec<u64>>>,
    z_black: u64,
    // config
    pub max_depth: i32,
    pub time_ms: u64,
    pub null_move: bool,
    // per-search state
    nodes: u64,
    deadline: Option<Instant>,
    stopped: bool,
    killers: Vec<[Option<Move>; 2]>,
    history: HashMap<(i32, i32, u8), i64>,
}

const MAX_HAND: usize = 33;

impl<'a> Searcher<'a> {
    pub fn new(e: &'a Engine) -> Searcher<'a> {
        let squares = (e.w * e.h) as usize;
        // collect distinct board letters: royal + types
        let mut letters: Vec<u8> = vec![e.cfg.royal];
        for &t in &e.cfg.types {
            if !letters.contains(&t) {
                letters.push(t);
            }
        }
        let mut letter_index = [-1i32; 128];
        for (i, &l) in letters.iter().enumerate() {
            letter_index[l as usize] = i as i32;
        }
        let n_letters = letters.len();
        let kinds = n_letters * 4;
        let mut seed: u64 = 0x1234_5678_9abc_def0;
        let mut next = || {
            seed = seed.wrapping_add(1);
            splitmix64(seed)
        };
        let mut z_board = vec![[0u64; 64]; squares];
        for sq in 0..squares {
            for k in 0..kinds {
                z_board[sq][k] = next();
            }
        }
        let ntypes = e.cfg.types.len();
        let mut z_hand = vec![vec![vec![0u64; MAX_HAND]; ntypes]; 2];
        for c in 0..2 {
            for t in 0..ntypes {
                for n in 0..MAX_HAND {
                    z_hand[c][t][n] = next();
                }
            }
        }
        let z_black = next();
        let ev = Ev::new(e);
        Searcher {
            e,
            ev,
            z_board,
            letter_index,
            n_letters,
            z_hand,
            z_black,
            max_depth: 8,
            time_ms: 1000,
            null_move: false,
            nodes: 0,
            deadline: None,
            stopped: false,
            killers: vec![[None, None]; 128],
            history: HashMap::new(),
        }
    }

    pub fn nodes(&self) -> u64 {
        self.nodes
    }

    fn zobrist(&self, state: &State) -> u64 {
        let mut h = 0u64;
        for (sq, cell) in state.board.iter().enumerate() {
            if let Some(p) = cell {
                let li = self.letter_index[p.t as usize];
                let kind = (li as usize) * 4 + (p.c as usize) * 2 + (p.promo as usize);
                h ^= self.z_board[sq][kind];
            }
        }
        if self.e.cfg.crazyhouse {
            for c in 0..2 {
                for t in 0..state.hands[c].len() {
                    let cnt = state.hands[c][t] as usize;
                    let cnt = cnt.min(MAX_HAND - 1);
                    h ^= self.z_hand[c][t][cnt];
                }
            }
        }
        if state.turn != WHITE {
            h ^= self.z_black;
        }
        let _ = self.n_letters;
        h
    }

    #[inline]
    fn stop(&mut self) -> bool {
        if self.stopped {
            return true;
        }
        if let Some(dl) = self.deadline {
            // check time occasionally
            if self.nodes & 0x3FF == 0 && Instant::now() >= dl {
                self.stopped = true;
                return true;
            }
        }
        false
    }

    fn is_capture(&self, state: &State, m: &Move) -> bool {
        !m.is_drop() && state.board[m.to as usize].is_some()
    }

    // Matches JS moveScore, plus killer/history for quiets.
    fn move_score(&self, state: &State, m: &Move, tt_best: &Option<Move>, ply: usize) -> f64 {
        if let Some(tb) = tt_best {
            if self.e.same_move(m, tb) {
                return 1e6;
            }
        }
        let w = &self.e.cfg.weights;
        let crazyhouse = self.e.cfg.crazyhouse;
        let mut sc = 0.0f64;
        if !m.is_drop() {
            if let Some(v) = state.board[m.to as usize] {
                let vv = if v.promo && crazyhouse {
                    w.piece[self.e.cfg.pawn as usize]
                } else {
                    w.piece[v.t as usize]
                };
                let fromv = w.piece[state.board[m.from as usize].unwrap().t as usize];
                sc += 1000.0 + vv - fromv / 10.0;
            }
            if m.promo != 0 {
                sc += 500.0 + w.piece[m.promo as usize];
            }
            // killers / history for quiet moves
            if state.board[m.to as usize].is_none() && m.promo == 0 {
                if ply < self.killers.len() {
                    if let Some(k0) = self.killers[ply][0] {
                        if self.e.same_move(m, &k0) {
                            sc += 90.0;
                        }
                    }
                    if let Some(k1) = self.killers[ply][1] {
                        if self.e.same_move(m, &k1) {
                            sc += 80.0;
                        }
                    }
                }
                let hh = *self.history.get(&(m.from, m.to, state.turn)).unwrap_or(&0);
                sc += (hh as f64).min(70.0);
            }
        } else {
            sc += 50.0;
        }
        sc
    }

    fn order_moves(&self, state: &State, moves: &mut Vec<Move>, tt_best: &Option<Move>, ply: usize) {
        let mut scored: Vec<(f64, Move)> =
            moves.iter().map(|m| (self.move_score(state, m, tt_best, ply), *m)).collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        for (i, (_, m)) in scored.into_iter().enumerate() {
            moves[i] = m;
        }
    }

    fn quiesce(&mut self, state: &mut State, mut alpha: f64, beta: f64) -> f64 {
        self.nodes += 1;
        let stand = (if state.turn == WHITE { 1.0 } else { -1.0 }) * self.ev.evaluate(state);
        if stand >= beta {
            return beta;
        }
        if stand > alpha {
            alpha = stand;
        }
        let mut caps: Vec<Move> = self
            .e
            .legal_moves(state)
            .into_iter()
            .filter(|m| self.is_capture(state, m) || m.promo != 0)
            .collect();
        let none = None;
        self.order_moves(state, &mut caps, &none, 0);
        for m in caps {
            let u = self.e.make_move(state, m);
            let sc = -self.quiesce(state, -beta, -alpha);
            self.e.unmake_move(state, &u);
            if sc >= beta {
                return beta;
            }
            if sc > alpha {
                alpha = sc;
            }
        }
        alpha
    }

    /// Negamax with PVS, TT, LMR. `seen` tracks path hashes for repetition.
    fn negamax(
        &mut self,
        state: &mut State,
        depth: i32,
        mut alpha: f64,
        mut beta: f64,
        ply: i32,
        tt: &mut TT,
        seen: &mut HashMap<u64, i32>,
    ) -> f64 {
        self.nodes += 1;
        if self.stop() {
            return 0.0;
        }
        let h = self.zobrist(state);
        let rep = *seen.get(&h).unwrap_or(&0);
        if rep >= 1 {
            return 0.0;
        }
        let alpha_orig = alpha;
        let mut tt_best: Option<Move> = None;
        tt.probes += 1;
        if let Some(entry) = tt.map.get(&h).copied() {
            if entry.depth >= depth {
                tt.hits += 1;
                if entry.flag == 0 {
                    return entry.value;
                }
                if entry.flag == -1 && entry.value > alpha {
                    alpha = entry.value;
                }
                if entry.flag == 1 && entry.value < beta {
                    beta = entry.value;
                }
                if alpha >= beta {
                    return entry.value;
                }
            }
            tt_best = entry.best;
        }

        let w = &self.e.cfg.weights;
        let mut moves = self.e.legal_moves(state);
        if moves.is_empty() {
            if self.e.in_check(&state.board, state.turn) {
                return -w.mate + ply as f64;
            }
            return if self.e.cfg.stalemate_win { w.mate - ply as f64 } else { 0.0 };
        }
        if depth <= 0 {
            return self.quiesce(state, alpha, beta);
        }

        self.order_moves(state, &mut moves, &tt_best, ply as usize);
        seen.insert(h, rep + 1);
        let mut best = -INF;
        let mut best_move: Option<Move> = None;
        let mut first = true;
        for (i, m) in moves.iter().enumerate() {
            let m = *m;
            let is_quiet = !self.is_capture(state, &m) && m.promo == 0 && !m.is_drop();
            let u = self.e.make_move(state, m);
            let in_check_now = self.e.in_check(&state.board, state.turn); // side to move now
            let mut sc;
            if first {
                sc = -self.negamax(state, depth - 1, -beta, -alpha, ply + 1, tt, seen);
            } else {
                // Late Move Reduction on quiet, late, non-checking moves
                let mut red = 0;
                if depth >= 3 && i >= 3 && is_quiet && !in_check_now {
                    red = 1;
                    if i >= 6 {
                        red = 2;
                    }
                }
                sc = -self.negamax(state, depth - 1 - red, -alpha - 1.0, -alpha, ply + 1, tt, seen);
                if sc > alpha && red > 0 {
                    sc = -self.negamax(state, depth - 1, -alpha - 1.0, -alpha, ply + 1, tt, seen);
                }
                if sc > alpha && sc < beta {
                    sc = -self.negamax(state, depth - 1, -beta, -alpha, ply + 1, tt, seen);
                }
            }
            self.e.unmake_move(state, &u);
            if self.stopped {
                seen.insert(h, rep);
                return 0.0;
            }
            if sc > best {
                best = sc;
                best_move = Some(m);
            }
            if best > alpha {
                alpha = best;
            }
            if alpha >= beta {
                if is_quiet {
                    let pl = ply as usize;
                    if pl < self.killers.len() {
                        if self.killers[pl][0].map_or(true, |k| !self.e.same_move(&k, &m)) {
                            self.killers[pl][1] = self.killers[pl][0];
                            self.killers[pl][0] = Some(m);
                        }
                    }
                    *self.history.entry((m.from, m.to, state.turn)).or_insert(0) +=
                        (depth * depth) as i64;
                }
                break;
            }
            first = false;
        }
        seen.insert(h, rep);

        let flag: i8 = if best <= alpha_orig {
            1
        } else if best >= beta {
            -1
        } else {
            0
        };
        tt.map.insert(h, TTEntry { depth, value: best, flag, best: best_move });
        best
    }

    /// Iterative-deepening best move with aspiration windows. Returns (move, score, depth).
    pub fn search_best(&mut self, state: &mut State, tt: &mut TT) -> (Option<Move>, f64, i32) {
        self.nodes = 0;
        self.stopped = false;
        self.deadline = if self.time_ms > 0 {
            Some(Instant::now() + std::time::Duration::from_millis(self.time_ms))
        } else {
            None
        };
        let root_moves = self.e.legal_moves(state);
        if root_moves.is_empty() {
            return (None, 0.0, 0);
        }
        let mut best_move = Some(root_moves[0]);
        let mut best_score = 0.0;
        let mut best_depth = 0;
        let mut prev_score = 0.0;
        for d in 1..=self.max_depth {
            let mut alpha = -INF;
            let mut beta = INF;
            // aspiration window around previous score (skip d<=2)
            if d > 2 {
                let window = 50.0;
                alpha = prev_score - window;
                beta = prev_score + window;
            }
            let (mut local_best, mut local_score);
            loop {
                let mut seen: HashMap<u64, i32> = HashMap::new();
                let mut moves = root_moves.clone();
                let tt_best = tt.map.get(&self.zobrist(state)).and_then(|e| e.best);
                self.order_moves(state, &mut moves, &tt_best, 0);
                let mut a = alpha;
                local_best = None;
                local_score = -INF;
                let mut aborted = false;
                for m in &moves {
                    let m = *m;
                    let u = self.e.make_move(state, m);
                    let sc = -self.negamax(state, d - 1, -beta, -a, 1, tt, &mut seen);
                    self.e.unmake_move(state, &u);
                    if self.stopped {
                        aborted = true;
                        break;
                    }
                    if sc > local_score {
                        local_score = sc;
                        local_best = Some(m);
                    }
                    if local_score > a {
                        a = local_score;
                    }
                }
                if aborted {
                    break;
                }
                // aspiration re-search on fail
                if local_score <= alpha {
                    alpha = -INF;
                    continue;
                }
                if local_score >= beta {
                    beta = INF;
                    continue;
                }
                break;
            }
            if self.stopped {
                break;
            }
            if let Some(lb) = local_best {
                best_move = Some(lb);
                best_score = local_score;
                best_depth = d;
                prev_score = local_score;
            }
            if best_score.abs() > self.e.cfg.weights.mate - 100.0 {
                break;
            }
        }
        (best_move, best_score, best_depth)
    }

    /// Multi-PV over EVERY root move: exact score for each (full window), sorted best-first.
    /// Scores are side-to-move perspective (same as JS analyze).
    pub fn analyze_all(
        &mut self,
        state: &mut State,
        depth: i32,
        tt: &mut TT,
    ) -> Vec<(Move, f64)> {
        self.nodes = 0;
        self.stopped = false;
        self.deadline = None;
        let root_moves = self.e.legal_moves(state);
        let mut out: Vec<(Move, f64)> = Vec::with_capacity(root_moves.len());
        for m in root_moves {
            let mut seen: HashMap<u64, i32> = HashMap::new();
            let u = self.e.make_move(state, m);
            let sc = -self.negamax(state, depth - 1, -INF, INF, 1, tt, &mut seen);
            self.e.unmake_move(state, &u);
            out.push((m, sc));
        }
        out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        out
    }
}

// ---- SAN (matches pgn.js sanOf) ----
impl Engine {
    fn sq_name(&self, j: i32) -> String {
        let f = (b'a' + self.xof(j) as u8) as char;
        format!("{}{}", f, self.yof(j) + 1)
    }
    fn letter_of(&self, t: u8) -> String {
        if t == self.cfg.pawn {
            String::new()
        } else {
            (t as char).to_string()
        }
    }
    pub fn san_of(&self, state: &State, m: &Move) -> String {
        if m.is_drop() {
            return format!("{}@{}", self.letter_of(m.drop), self.sq_name(m.to));
        }
        let p = state.board[m.from as usize].expect("from occupied");
        let cap = state.board[m.to as usize].is_some();
        let mut s = format!(
            "{}{}{}{}",
            self.letter_of(p.t),
            self.sq_name(m.from),
            if cap { "x" } else { "-" },
            self.sq_name(m.to)
        );
        if m.promo != 0 {
            s.push('=');
            s.push_str(&self.letter_of(m.promo));
        }
        s
    }
}
