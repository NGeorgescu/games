//! Static evaluation, copied term-for-term from chesslib/search.js `evaluate`.
//! Returns a WHITE-positive score on the same scale as the JS engine.

use crate::engine::{Engine, State, BLACK, WHITE};

pub struct Ev<'a> {
    pub e: &'a Engine,
    king8: Vec<(i32, i32)>,
    mid_x: [i32; 2],
    mid_y: [i32; 2],
}

impl<'a> Ev<'a> {
    pub fn new(e: &'a Engine) -> Ev<'a> {
        let w = e.w;
        let h = e.h;
        let king8: Vec<(i32, i32)> = [(1, 0), (-1, 0), (0, 1), (0, -1),
            (1, 1), (1, -1), (-1, 1), (-1, -1)].to_vec();
        Ev {
            e,
            king8,
            mid_x: [w / 2 - 1, w / 2],
            mid_y: [h / 2 - 1, h / 2],
        }
    }

    /// White-positive static eval (matches JS `evaluate(state, w)`).
    pub fn evaluate(&self, state: &mut State) -> f64 {
        let e = self.e;
        let w = &e.cfg.weights;
        let crazyhouse = e.cfg.crazyhouse;
        let pawn = e.cfg.pawn;
        let royal = e.cfg.royal;
        let b = &state.board;
        let mut s = 0.0f64;
        for i in 0..b.len() {
            let p = match b[i] {
                Some(p) => p,
                None => continue,
            };
            if p.t == royal {
                continue;
            }
            let base = if p.promo && crazyhouse {
                w.piece[pawn as usize]
            } else {
                w.piece[p.t as usize]
            };
            let sign = if p.c == WHITE { 1.0 } else { -1.0 };
            s += sign * base;
            if p.t == pawn {
                let yof = e.yof(i as i32);
                let adv = if p.c == WHITE { yof } else { e.h - 1 - yof } as f64;
                s += sign * adv * w.pawn_advance;
            }
            if let Some(cp) = e.cfg.central_piece {
                if p.t == cp {
                    let x = e.xof(i as i32);
                    let y = e.yof(i as i32);
                    let central = if (x == self.mid_x[0] || x == self.mid_x[1])
                        && (y == self.mid_y[0] || y == self.mid_y[1])
                    {
                        1.0
                    } else {
                        0.0
                    };
                    s += sign * central * w.central;
                }
            }
        }
        for &c in &[WHITE, BLACK] {
            let sign = if c == WHITE { 1.0 } else { -1.0 };
            let h = &state.hands[c as usize];
            for (ti, &t) in e.cfg.types.iter().enumerate() {
                s += sign * (h[ti] as f64) * w.piece[t as usize] * w.hand_bonus;
            }
        }
        for &c in &[WHITE, BLACK] {
            let k = e.king_square(b, c);
            if k < 0 {
                continue;
            }
            let x = e.xof(k);
            let y = e.yof(k);
            let mut empt = 0.0f64;
            for &(dx, dy) in &self.king8 {
                let nx = x + dx;
                let ny = y + dy;
                if !e.inb(nx, ny) {
                    continue;
                }
                if b[e.idx(nx, ny) as usize].is_none() {
                    empt += 1.0;
                }
            }
            let sign = if c == WHITE { 1.0 } else { -1.0 };
            let opp_hand: i32 = state.hands[(1 - c) as usize].iter().sum();
            let opp = opp_hand.min(4) as f64;
            s -= sign * empt * w.king_exposure * (1.0 + opp * 0.25);
        }
        let mob = e.legal_moves(state).len() as f64;
        s += (if state.turn == WHITE { 1.0 } else { -1.0 }) * mob * w.mobility;
        s
    }
}
