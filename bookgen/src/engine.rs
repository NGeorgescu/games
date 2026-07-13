//! Config-driven variant engine, a faithful port of chesslib/engine.js.
//!
//! Board is a flat `Vec<Cell>` of length W*H, row-major (`idx = y*W + x`),
//! matching the JS `IDX = (x,y)=>y*W+x`. Move generation is driven by
//! per-piece specs (leaps / mao / slides / pawn / royal). make/unmake are
//! exact inverses. `key()` reproduces engine.js's `key()` byte-for-byte.

pub const WHITE: u8 = 0;
pub const BLACK: u8 = 1;

/// Knight offsets, identical order to engine.js `KNIGHT`.
pub const KNIGHT: [(i32, i32); 8] = [
    (1, 2), (2, 1), (2, -1), (1, -2), (-1, -2), (-2, -1), (-2, 1), (-1, 2),
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Piece {
    /// piece type as an uppercase ASCII letter, e.g. b'K'
    pub t: u8,
    pub c: u8,
    pub promo: bool,
}

pub type Cell = Option<Piece>;

#[derive(Clone, Debug)]
pub struct PieceSpec {
    pub leaps: Vec<(i32, i32)>,
    pub slides: Vec<(i32, i32)>,
    pub mao: bool,
    pub pawn: bool,
    pub royal: bool,
}

impl Default for PieceSpec {
    fn default() -> Self {
        PieceSpec { leaps: vec![], slides: vec![], mao: false, pawn: false, royal: false }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub id: String,
    pub files: i32,
    pub ranks: i32,
    /// hand / drop order, uppercase letters
    pub types: Vec<u8>,
    pub royal: u8,
    pub pawn: u8,
    /// spec by ASCII letter (index by byte); None if not a piece
    pub specs: Vec<Option<PieceSpec>>,
    /// (x,y,letter,color)
    pub setup: Vec<(i32, i32, u8, u8)>,
    pub crazyhouse: bool,
    /// true => stalemate is a win for the stalemated... i.e. side with no moves & not in check scores +MATE
    pub stalemate_win: bool,
    pub promote_to: Vec<u8>,
    // ---- eval config ----
    pub weights: Weights,
    pub central_piece: Option<u8>,
}

#[derive(Clone, Debug)]
pub struct Weights {
    /// piece value by ASCII letter
    pub piece: [f64; 128],
    pub hand_bonus: f64,
    pub mobility: f64,
    pub king_exposure: f64,
    pub pawn_advance: f64,
    pub mate: f64,
    /// value for the config's centralWeightKey
    pub central: f64,
}

impl Config {
    #[inline]
    pub fn spec(&self, t: u8) -> &PieceSpec {
        self.specs[t as usize].as_ref().expect("spec for piece type")
    }
}

/// A move. `from < 0` marks a drop. `promo`/`drop` are 0 when unused.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Move {
    pub from: i32,
    pub to: i32,
    pub promo: u8,
    pub drop: u8,
    pub double: bool,
}

impl Move {
    #[inline]
    pub fn normal(from: i32, to: i32) -> Move {
        Move { from, to, promo: 0, drop: 0, double: false }
    }
    #[inline]
    pub fn is_drop(&self) -> bool {
        self.drop != 0
    }
    /// Canonical id string, identical to search.js `mvId`.
    pub fn id(&self) -> String {
        if self.is_drop() {
            format!("*{}@{}", self.drop as char, self.to)
        } else if self.promo != 0 {
            format!("{}>{}{}", self.from, self.to, self.promo as char)
        } else {
            format!("{}>{}", self.from, self.to)
        }
    }
}

/// Undo record for exact unmake.
pub struct Undo {
    pub turn: u8,
    pub m: Move,
    pub cap: Cell,
}

#[derive(Clone)]
pub struct State {
    pub board: Vec<Cell>,
    /// hands[color][type-index-in-config.types]
    pub hands: [Vec<i32>; 2],
    pub turn: u8,
}

pub struct Engine {
    pub cfg: Config,
    pub w: i32,
    pub h: i32,
}

impl Engine {
    pub fn new(cfg: Config) -> Engine {
        let w = cfg.files;
        let h = cfg.ranks;
        Engine { cfg, w, h }
    }

    #[inline]
    pub fn idx(&self, x: i32, y: i32) -> i32 {
        y * self.w + x
    }
    #[inline]
    pub fn xof(&self, i: i32) -> i32 {
        i % self.w
    }
    #[inline]
    pub fn yof(&self, i: i32) -> i32 {
        i / self.w
    }
    #[inline]
    pub fn inb(&self, x: i32, y: i32) -> bool {
        x >= 0 && x < self.w && y >= 0 && y < self.h
    }

    /// The "leg" square a mao steps over. Mirrors engine.js `legSquare`.
    #[inline]
    fn leg_square(&self, x: i32, y: i32, dx: i32, dy: i32) -> (i32, i32) {
        if dx.abs() == 2 {
            (x + if dx > 0 { 1 } else { -1 }, y)
        } else {
            (x, y + if dy > 0 { 1 } else { -1 })
        }
    }

    fn type_index(&self, t: u8) -> usize {
        self.cfg.types.iter().position(|&x| x == t).expect("type in config.types")
    }

    pub fn empty_hand(&self) -> Vec<i32> {
        vec![0; self.cfg.types.len()]
    }

    pub fn initial_state(&self) -> State {
        let mut board: Vec<Cell> = vec![None; (self.w * self.h) as usize];
        for &(x, y, t, c) in &self.cfg.setup {
            let i = self.idx(x, y) as usize;
            board[i] = Some(Piece { t, c, promo: false });
        }
        State { board, hands: [self.empty_hand(), self.empty_hand()], turn: WHITE }
    }

    // ---- attack detection (reverse of each movement spec) ----
    pub fn attacked(&self, board: &[Cell], i: i32, by: u8) -> bool {
        let x = self.xof(i);
        let y = self.yof(i);
        // iterate over piece types; order matches Object.entries(pieces) insertion.
        for lt in 0u8..128 {
            let spec = match &self.cfg.specs[lt as usize] {
                Some(s) => s,
                None => continue,
            };
            if !spec.leaps.is_empty() {
                for &(dx, dy) in &spec.leaps {
                    let sx = x - dx;
                    let sy = y - dy;
                    if !self.inb(sx, sy) {
                        continue;
                    }
                    if let Some(p) = board[self.idx(sx, sy) as usize] {
                        if p.c == by && p.t == lt {
                            return true;
                        }
                    }
                }
            }
            if !spec.slides.is_empty() {
                for &(dx, dy) in &spec.slides {
                    let mut nx = x + dx;
                    let mut ny = y + dy;
                    while self.inb(nx, ny) {
                        match board[self.idx(nx, ny) as usize] {
                            Some(p) => {
                                if p.c == by && p.t == lt {
                                    return true;
                                }
                                break;
                            }
                            None => {}
                        }
                        nx += dx;
                        ny += dy;
                    }
                }
            }
            if spec.mao {
                for &(dx, dy) in &KNIGHT {
                    let ax = x + dx;
                    let ay = y + dy;
                    if !self.inb(ax, ay) {
                        continue;
                    }
                    match board[self.idx(ax, ay) as usize] {
                        Some(p) if p.c == by && p.t == lt => {
                            let (lx, ly) = self.leg_square(ax, ay, -dx, -dy);
                            if board[self.idx(lx, ly) as usize].is_none() {
                                return true;
                            }
                        }
                        _ => {}
                    }
                }
            }
            if spec.pawn {
                let df: i32 = if by == WHITE { 1 } else { -1 };
                let from_y = y - df;
                for dx in [-1i32, 1] {
                    let nx = x - dx;
                    if !self.inb(nx, from_y) {
                        continue;
                    }
                    if let Some(p) = board[self.idx(nx, from_y) as usize] {
                        if p.c == by && p.t == lt {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    pub fn king_square(&self, board: &[Cell], c: u8) -> i32 {
        for (i, cell) in board.iter().enumerate() {
            if let Some(p) = cell {
                if p.c == c && p.t == self.cfg.royal {
                    return i as i32;
                }
            }
        }
        -1
    }

    pub fn in_check(&self, board: &[Cell], c: u8) -> bool {
        let k = self.king_square(board, c);
        k >= 0 && self.attacked(board, k, 1 - c)
    }

    fn add_pawn(&self, moves: &mut Vec<Move>, from: i32, to: i32, is_promo: bool) {
        if is_promo {
            for &pt in &self.cfg.promote_to {
                moves.push(Move { from, to, promo: pt, drop: 0, double: false });
            }
        } else {
            moves.push(Move::normal(from, to));
        }
    }

    pub fn pseudo_moves(&self, state: &State) -> Vec<Move> {
        let turn = state.turn;
        let board = &state.board;
        let mut moves: Vec<Move> = Vec::with_capacity(48);
        let promo_rank = if turn == WHITE { self.h - 1 } else { 0 };
        for i in 0..board.len() as i32 {
            let p = match board[i as usize] {
                Some(p) if p.c == turn => p,
                _ => continue,
            };
            let x = self.xof(i);
            let y = self.yof(i);
            let spec = self.cfg.spec(p.t);
            if !spec.leaps.is_empty() {
                for &(dx, dy) in &spec.leaps {
                    let nx = x + dx;
                    let ny = y + dy;
                    if !self.inb(nx, ny) {
                        continue;
                    }
                    let j = self.idx(nx, ny);
                    if let Some(q) = board[j as usize] {
                        if q.c == turn {
                            continue;
                        }
                    }
                    moves.push(Move::normal(i, j));
                }
            }
            if !spec.slides.is_empty() {
                for &(dx, dy) in &spec.slides {
                    let mut nx = x + dx;
                    let mut ny = y + dy;
                    while self.inb(nx, ny) {
                        let j = self.idx(nx, ny);
                        match board[j as usize] {
                            Some(q) => {
                                if q.c != turn {
                                    moves.push(Move::normal(i, j));
                                }
                                break;
                            }
                            None => {
                                moves.push(Move::normal(i, j));
                            }
                        }
                        nx += dx;
                        ny += dy;
                    }
                }
            }
            if spec.mao {
                for &(dx, dy) in &KNIGHT {
                    let nx = x + dx;
                    let ny = y + dy;
                    if !self.inb(nx, ny) {
                        continue;
                    }
                    let (lx, ly) = self.leg_square(x, y, dx, dy);
                    if board[self.idx(lx, ly) as usize].is_some() {
                        continue;
                    }
                    let j = self.idx(nx, ny);
                    if let Some(q) = board[j as usize] {
                        if q.c == turn {
                            continue;
                        }
                    }
                    moves.push(Move::normal(i, j));
                }
            }
            if spec.pawn {
                let df: i32 = if turn == WHITE { 1 } else { -1 };
                let fy = y + df;
                if self.inb(x, fy) && board[self.idx(x, fy) as usize].is_none() {
                    self.add_pawn(&mut moves, i, self.idx(x, fy), fy == promo_rank);
                    // double-step is OFF for all current variants (spec.pawn double not modeled)
                }
                for dx in [-1i32, 1] {
                    let nx = x + dx;
                    if !self.inb(nx, fy) {
                        continue;
                    }
                    let j = self.idx(nx, fy);
                    if let Some(q) = board[j as usize] {
                        if q.c != turn {
                            self.add_pawn(&mut moves, i, j, fy == promo_rank);
                        }
                    }
                }
            }
        }
        if self.cfg.crazyhouse {
            let hand = &state.hands[turn as usize];
            for (ti, &t) in self.cfg.types.iter().enumerate() {
                if hand[ti] <= 0 {
                    continue;
                }
                let restrict = self.cfg.spec(t).pawn;
                for j in 0..board.len() as i32 {
                    if board[j as usize].is_some() {
                        continue;
                    }
                    if restrict && self.yof(j) == promo_rank {
                        continue;
                    }
                    moves.push(Move { from: -1, to: j, promo: 0, drop: t, double: false });
                }
            }
        }
        moves
    }

    pub fn make_move(&self, state: &mut State, m: Move) -> Undo {
        let turn = state.turn;
        let mut undo = Undo { turn, m, cap: None };
        if m.is_drop() {
            state.board[m.to as usize] = Some(Piece { t: m.drop, c: turn, promo: false });
            if self.cfg.crazyhouse {
                let ti = self.type_index(m.drop);
                state.hands[turn as usize][ti] -= 1;
            }
        } else {
            let p = state.board[m.from as usize].expect("from occupied");
            let q = state.board[m.to as usize];
            if let Some(qp) = q {
                undo.cap = Some(qp);
                if self.cfg.crazyhouse {
                    let gained = if qp.promo { self.cfg.pawn } else { qp.t };
                    let ti = self.type_index(gained);
                    state.hands[turn as usize][ti] += 1;
                }
            }
            state.board[m.to as usize] = if m.promo != 0 {
                Some(Piece { t: m.promo, c: turn, promo: true })
            } else {
                Some(Piece { t: p.t, c: turn, promo: p.promo })
            };
            state.board[m.from as usize] = None;
        }
        state.turn = 1 - turn;
        undo
    }

    pub fn unmake_move(&self, state: &mut State, undo: &Undo) {
        let turn = undo.turn;
        let m = undo.m;
        state.turn = turn;
        if m.is_drop() {
            state.board[m.to as usize] = None;
            if self.cfg.crazyhouse {
                let ti = self.type_index(m.drop);
                state.hands[turn as usize][ti] += 1;
            }
        } else {
            let cur = state.board[m.to as usize].expect("to occupied after move");
            state.board[m.from as usize] = if m.promo != 0 {
                Some(Piece { t: self.cfg.pawn, c: turn, promo: false })
            } else {
                Some(Piece { t: cur.t, c: turn, promo: cur.promo })
            };
            if let Some(cap) = undo.cap {
                state.board[m.to as usize] = Some(cap);
                if self.cfg.crazyhouse {
                    let gained = if cap.promo { self.cfg.pawn } else { cap.t };
                    let ti = self.type_index(gained);
                    state.hands[turn as usize][ti] -= 1;
                }
            } else {
                state.board[m.to as usize] = None;
            }
        }
    }

    pub fn legal_moves(&self, state: &mut State) -> Vec<Move> {
        let turn = state.turn;
        let pseudo = self.pseudo_moves(state);
        let mut out = Vec::with_capacity(pseudo.len());
        for m in pseudo {
            let u = self.make_move(state, m);
            if !self.in_check(&state.board, turn) {
                out.push(m);
            }
            self.unmake_move(state, &u);
        }
        out
    }

    pub fn status_of(&self, state: &mut State) -> &'static str {
        let legal = self.legal_moves(state);
        if !legal.is_empty() {
            return "ongoing";
        }
        if self.in_check(&state.board, state.turn) {
            "checkmate"
        } else {
            "stalemate"
        }
    }

    /// Byte-for-byte identical to engine.js `key()`.
    pub fn key(&self, state: &State) -> String {
        let mut s = String::with_capacity(state.board.len() + 16);
        for cell in &state.board {
            match cell {
                Some(p) => {
                    let ch = if p.c == WHITE {
                        p.t as char
                    } else {
                        (p.t as char).to_ascii_lowercase()
                    };
                    s.push(ch);
                    if p.promo {
                        s.push('*');
                    }
                }
                None => s.push('.'),
            }
        }
        if self.cfg.crazyhouse {
            s.push('|');
            for (ti, _) in self.cfg.types.iter().enumerate() {
                s.push_str(&state.hands[WHITE as usize][ti].to_string());
            }
            s.push('/');
            for (ti, _) in self.cfg.types.iter().enumerate() {
                s.push_str(&state.hands[BLACK as usize][ti].to_string());
            }
        }
        s.push('|');
        s.push_str(&state.turn.to_string());
        s
    }

    /// Parse a `key()` string back into a full State (move-gen complete;
    /// history/repetition are not encoded and not needed for movegen).
    pub fn from_key(&self, key: &str) -> State {
        let parts: Vec<&str> = key.split('|').collect();
        let board_str = parts[0];
        let mut board: Vec<Cell> = vec![None; (self.w * self.h) as usize];
        let mut idx = 0usize;
        let chars: Vec<char> = board_str.chars().collect();
        let mut ci = 0;
        while ci < chars.len() {
            let ch = chars[ci];
            ci += 1;
            if ch == '.' {
                idx += 1;
                continue;
            }
            let promo = ci < chars.len() && chars[ci] == '*';
            if promo {
                ci += 1;
            }
            let c = if ch.is_ascii_uppercase() { WHITE } else { BLACK };
            let t = ch.to_ascii_uppercase() as u8;
            board[idx] = Some(Piece { t, c, promo });
            idx += 1;
        }
        let mut hands = [self.empty_hand(), self.empty_hand()];
        let turn: u8;
        if self.cfg.crazyhouse {
            // parts = [board, "wdigits/bdigits", turn]
            let hs: Vec<&str> = parts[1].split('/').collect();
            let wd: Vec<char> = hs[0].chars().collect();
            let bd: Vec<char> = hs[1].chars().collect();
            for ti in 0..self.cfg.types.len() {
                hands[WHITE as usize][ti] = wd[ti].to_digit(10).unwrap() as i32;
                hands[BLACK as usize][ti] = bd[ti].to_digit(10).unwrap() as i32;
            }
            turn = parts[2].parse().unwrap();
        } else {
            turn = parts[1].parse().unwrap();
        }
        State { board, hands, turn }
    }

    pub fn same_move(&self, a: &Move, b: &Move) -> bool {
        a.from == b.from && a.to == b.to && a.drop == b.drop && a.promo == b.promo
    }

    pub fn perft(&self, state: &mut State, depth: u32) -> u64 {
        if depth == 0 {
            return 1;
        }
        let mut n = 0u64;
        for m in self.legal_moves(state) {
            let u = self.make_move(state, m);
            n += self.perft(state, depth - 1);
            self.unmake_move(state, &u);
        }
        n
    }
}
