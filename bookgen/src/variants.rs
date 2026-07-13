//! The three variant configs, ported from chesslib/variants/*.js.

use crate::engine::{Config, PieceSpec, Weights, BLACK, KNIGHT, WHITE};

const ORTH: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];
const DIAG: [(i32, i32); 4] = [(1, 1), (1, -1), (-1, 1), (-1, -1)];
fn king8() -> Vec<(i32, i32)> {
    // ORTH.concat(DIAG) — order matches engine.js KING8
    ORTH.iter().chain(DIAG.iter()).copied().collect()
}

fn empty_specs() -> Vec<Option<PieceSpec>> {
    vec![None; 128]
}

fn leaps(v: Vec<(i32, i32)>) -> PieceSpec {
    PieceSpec { leaps: v, ..Default::default() }
}
fn slides(v: Vec<(i32, i32)>) -> PieceSpec {
    PieceSpec { slides: v, ..Default::default() }
}

fn mk_weights(pairs: &[(u8, f64)], hand_bonus: f64, mobility: f64, king_exposure: f64,
              pawn_advance: f64, mate: f64, central: f64) -> Weights {
    let mut piece = [0.0f64; 128];
    for &(t, v) in pairs {
        piece[t as usize] = v;
    }
    Weights { piece, hand_bonus, mobility, king_exposure, pawn_advance, mate, central }
}

pub fn tinyhouse() -> Config {
    let mut specs = empty_specs();
    specs[b'K' as usize] = Some(PieceSpec { royal: true, ..leaps(king8()) });
    specs[b'W' as usize] = Some(leaps(ORTH.to_vec()));
    specs[b'F' as usize] = Some(leaps(DIAG.to_vec()));
    specs[b'D' as usize] = Some(PieceSpec { mao: true, ..Default::default() });
    specs[b'P' as usize] = Some(PieceSpec { pawn: true, ..Default::default() });
    Config {
        id: "tinyhouse".into(),
        files: 4, ranks: 4,
        types: vec![b'P', b'W', b'F', b'D'],
        royal: b'K', pawn: b'P',
        specs,
        setup: vec![
            (0, 0, b'K', WHITE), (1, 0, b'W', WHITE), (2, 0, b'D', WHITE), (3, 0, b'F', WHITE), (0, 1, b'P', WHITE),
            (3, 3, b'K', BLACK), (2, 3, b'W', BLACK), (1, 3, b'D', BLACK), (0, 3, b'F', BLACK), (3, 2, b'P', BLACK),
        ],
        crazyhouse: true,
        stalemate_win: true,
        promote_to: vec![b'W', b'F', b'D'],
        weights: mk_weights(
            &[(b'P', 100.0), (b'W', 246.14), (b'F', 235.883), (b'D', 188.726)],
            1.489, 3.242, 7.133, 6.001, 100000.0, 8.336),
        central_piece: Some(b'D'),
    }
}

pub fn minihouse() -> Config {
    let mut specs = empty_specs();
    specs[b'K' as usize] = Some(PieceSpec { royal: true, ..leaps(king8()) });
    specs[b'R' as usize] = Some(slides(ORTH.to_vec()));
    specs[b'N' as usize] = Some(leaps(KNIGHT.to_vec()));
    specs[b'B' as usize] = Some(slides(DIAG.to_vec()));
    specs[b'P' as usize] = Some(PieceSpec { pawn: true, ..Default::default() });
    Config {
        id: "minihouse".into(),
        files: 6, ranks: 6,
        types: vec![b'P', b'R', b'N', b'B'],
        royal: b'K', pawn: b'P',
        specs,
        setup: vec![
            (0, 0, b'K', WHITE), (1, 0, b'R', WHITE), (2, 0, b'N', WHITE), (3, 0, b'B', WHITE), (0, 1, b'P', WHITE),
            (5, 5, b'K', BLACK), (4, 5, b'R', BLACK), (3, 5, b'N', BLACK), (2, 5, b'B', BLACK), (5, 4, b'P', BLACK),
        ],
        crazyhouse: true,
        stalemate_win: true,
        promote_to: vec![b'R', b'N', b'B'],
        weights: mk_weights(
            &[(b'P', 100.0), (b'R', 500.0), (b'N', 300.0), (b'B', 320.0)],
            1.3, 2.0, 7.0, 6.0, 100000.0, 8.0),
        central_piece: Some(b'N'),
    }
}

pub fn gardner() -> Config {
    let mut specs = empty_specs();
    specs[b'K' as usize] = Some(PieceSpec { royal: true, ..leaps(king8()) });
    specs[b'Q' as usize] = Some(slides(king8()));
    specs[b'R' as usize] = Some(slides(ORTH.to_vec()));
    specs[b'B' as usize] = Some(slides(DIAG.to_vec()));
    specs[b'N' as usize] = Some(leaps(KNIGHT.to_vec()));
    specs[b'P' as usize] = Some(PieceSpec { pawn: true, ..Default::default() });
    Config {
        id: "gardner".into(),
        files: 5, ranks: 5,
        types: vec![b'P', b'N', b'B', b'R', b'Q'],
        royal: b'K', pawn: b'P',
        specs,
        setup: vec![
            (0, 0, b'R', WHITE), (1, 0, b'N', WHITE), (2, 0, b'B', WHITE), (3, 0, b'Q', WHITE), (4, 0, b'K', WHITE),
            (0, 1, b'P', WHITE), (1, 1, b'P', WHITE), (2, 1, b'P', WHITE), (3, 1, b'P', WHITE), (4, 1, b'P', WHITE),
            (0, 4, b'R', BLACK), (1, 4, b'N', BLACK), (2, 4, b'B', BLACK), (3, 4, b'Q', BLACK), (4, 4, b'K', BLACK),
            (0, 3, b'P', BLACK), (1, 3, b'P', BLACK), (2, 3, b'P', BLACK), (3, 3, b'P', BLACK), (4, 3, b'P', BLACK),
        ],
        crazyhouse: false,
        stalemate_win: false,
        promote_to: vec![b'Q', b'R', b'B', b'N'],
        weights: mk_weights(
            &[(b'P', 100.0), (b'N', 300.0), (b'B', 320.0), (b'R', 500.0), (b'Q', 900.0)],
            0.0, 3.0, 6.0, 6.0, 100000.0, 8.0),
        central_piece: Some(b'N'),
    }
}

pub fn by_name(name: &str) -> Option<Config> {
    match name {
        "tiny" | "tinyhouse" => Some(tinyhouse()),
        "mini" | "minihouse" => Some(minihouse()),
        "gardner" => Some(gardner()),
        _ => None,
    }
}
