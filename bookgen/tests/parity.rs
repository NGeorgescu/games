// Self-contained parity/sanity tests mirroring the JS engine's known values.
use std::process::Command;

fn bin() -> &'static str { env!("CARGO_BIN_EXE_bookgen") }

fn run(args: &[&str]) -> String {
    let out = Command::new(bin()).args(args).output().expect("run bookgen");
    String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr)
}

#[test]
fn perft_parity() {
    // (variant, depth, expected) — matches chesslib JS engine perft.
    let cases = [
        ("tiny", 1, "6"), ("tiny", 2, "33"), ("tiny", 3, "246"), ("tiny", 4, "1939"),
        ("tiny", 6, "153180"),
        ("mini", 1, "15"), ("mini", 2, "220"), ("mini", 3, "3493"), ("mini", 4, "56173"),
        ("gardner", 1, "7"), ("gardner", 2, "53"), ("gardner", 3, "506"), ("gardner", 4, "4775"),
    ];
    for (v, d, exp) in cases {
        let o = run(&["perftv", v, &d.to_string(), exp]);
        assert!(o.contains("OK"), "{v} perft({d}) expected {exp}: {o}");
    }
}

#[test]
fn start_keys() {
    assert_eq!(run(&["key", "tiny"]).trim(), "KWDFP......pfdwk|0000/0000|0");
    assert_eq!(run(&["key", "mini"]).trim(), "KRNB..P......................p..bnrk|0000/0000|0");
    assert_eq!(run(&["key", "gardner"]).trim(), "RNBQKPPPPP.....ppppprnbqk|0");
}

#[test]
fn mate_in_one() {
    // Positions with a known mate-in-1 (found via the JS engine).
    let cases = [
        ("tiny", "FWDF.K..w..p.dk.|0000/1000|1", "8>4"),
        ("mini", "K.....P...B..N....P....R..R.....bnk.|0000/0000|0", "13>21"),
        ("gardner", "RnB...P.PKQ.N.pp.p.prR*q.k|0", "10>22"),
    ];
    for (v, key, mv) in cases {
        let o = run(&["analyze", v, "--key", key, "--depth", "3", "--topn", "1"]);
        assert!(o.contains("99999"), "{v} should find mate: {o}");
        assert!(o.contains(mv), "{v} top move should be {mv}: {o}");
    }
}
