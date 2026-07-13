//! bookgen CLI — Phase A (port + validate) for the chesslib variant engine.
//!
//! Subcommands:
//!   perft <variant> <depth>
//!   key <variant>
//!   analyze <variant> (--key <k> | --start) --depth <d> [--topn <n>]
//!   movedump <variant> (--key <k> | --start)
//!   genbook <variant> ...           (wired stub, not run in Phase A)

#![allow(dead_code)]

mod engine;
mod eval;
mod search;
mod variants;

use engine::{Engine, Move, State, WHITE};
use search::{Searcher, TT};
use std::collections::{HashSet, VecDeque};
use std::time::Instant;

/// Engine version stamped into book headers.
const ENGINE_VERSION: &str = "bookgen-0.1.0";

/// Deterministic shard index for a position key. Reproducible in JS as:
///   let h=0; for(const ch of key) h=(h*31+ch.charCodeAt(0))>>>0; return h % shardCount;
fn shard_of(key: &str, n: u32) -> u32 {
    if n <= 1 {
        return 0;
    }
    let mut h: u32 = 0;
    for b in key.bytes() {
        h = h.wrapping_mul(31).wrapping_add(b as u32);
    }
    h % n
}

/// Serialize one position's ranked move list to a JSON array of {san,cp}.
/// SAN and key strings are JSON-safe for these variants (letters, digits and
/// the punctuation `@ - x = . | / *`), so no escaping is required.
fn moves_json(arr: &[(String, i64)]) -> String {
    let mut s = String::from("[");
    for (i, (san, cp)) in arr.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!("{{\"san\":\"{}\",\"cp\":{}}}", san, cp));
    }
    s.push(']');
    s
}

fn get_engine(name: &str) -> Engine {
    match variants::by_name(name) {
        Some(cfg) => Engine::new(cfg),
        None => {
            eprintln!("unknown variant: {} (use tiny|mini|gardner)", name);
            std::process::exit(2);
        }
    }
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(|s| s.as_str())
}
fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn state_from_args(e: &Engine, args: &[String]) -> State {
    if let Some(k) = flag(args, "--key") {
        e.from_key(k)
    } else {
        e.initial_state()
    }
}

/// Sorted canonical move-id list (stable across engines) for equivalence tests.
fn sorted_move_ids(e: &Engine, state: &mut State) -> Vec<String> {
    let mut ids: Vec<String> = e.legal_moves(state).iter().map(|m| m.id()).collect();
    ids.sort();
    ids
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() < 2 {
        eprintln!("usage: bookgen <perft|key|analyze|movedump|genbook> ...");
        std::process::exit(2);
    }
    let cmd = argv[1].as_str();
    let args = &argv[2..];
    match cmd {
        "perft" => {
            let e = get_engine(&args[0]);
            let depth: u32 = args[1].parse().expect("depth");
            let mut st = e.initial_state();
            let t = Instant::now();
            let n = e.perft(&mut st, depth);
            let dt = t.elapsed().as_secs_f64();
            println!("{} perft({}) = {}  [{:.3}s]", args[0], depth, n, dt);
        }
        "key" => {
            let e = get_engine(&args[0]);
            let st = e.initial_state();
            println!("{}", e.key(&st));
        }
        "movedump" => {
            let e = get_engine(&args[0]);
            let mut st = state_from_args(&e, args);
            for id in sorted_move_ids(&e, &mut st) {
                println!("{}", id);
            }
        }
        "analyze" => {
            let e = get_engine(&args[0]);
            let mut st = state_from_args(&e, args);
            let depth: i32 = flag(args, "--depth").and_then(|s| s.parse().ok()).unwrap_or(6);
            let topn: usize = flag(args, "--topn").and_then(|s| s.parse().ok()).unwrap_or(usize::MAX);
            let mut s = Searcher::new(&e);
            s.null_move = has_flag(args, "--null");
            let mut tt = TT::new();
            let t = Instant::now();
            let ranked = s.analyze_all(&mut st, depth, &mut tt);
            let dt = t.elapsed().as_secs_f64();
            let stm_sign = if st.turn == engine::WHITE { 1.0 } else { -1.0 };
            println!("# {} analyze depth={} key={} nodes={} [{:.3}s]",
                     args[0], depth, e.key(&st), s.nodes(), dt);
            for (i, (m, sc)) in ranked.iter().enumerate() {
                if i >= topn {
                    break;
                }
                // white-relative cp for consistency
                let cp = stm_sign * sc;
                println!("{:>2}. {:<10} score(stm)={:>10.1}  cp(white)={:>10.1}  {}",
                         i + 1, e.san_of(&st, m), sc, cp, m.id());
            }
        }
        "crosscheck" => {
            // crosscheck <variant> <tsv>  — verify move-set + key round-trip + eval parity
            let e = get_engine(&args[0]);
            let path = &args[1];
            let data = std::fs::read_to_string(path).expect("read tsv");
            let evr = eval::Ev::new(&e);
            let (mut n, mut move_mm, mut key_mm, mut eval_mm) = (0u64, 0u64, 0u64, 0u64);
            let mut worst_eval = 0.0f64;
            for line in data.lines() {
                if line.is_empty() {
                    continue;
                }
                let cols: Vec<&str> = line.split('\t').collect();
                let key = cols[0];
                let exp_moves = cols.get(1).copied().unwrap_or("");
                let exp_eval: f64 = cols.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.0);
                n += 1;
                let mut st = e.from_key(key);
                // key round-trip
                if e.key(&st) != key {
                    key_mm += 1;
                    if key_mm <= 3 {
                        eprintln!("KEY mismatch: {} -> {}", key, e.key(&st));
                    }
                }
                // move-set
                let ids = sorted_move_ids(&e, &mut st).join(",");
                if ids != exp_moves {
                    move_mm += 1;
                    if move_mm <= 3 {
                        eprintln!("MOVE mismatch at {}\n  rust: {}\n  js:   {}", key, ids, exp_moves);
                    }
                }
                // eval
                let got = evr.evaluate(&mut st);
                let diff = (got - exp_eval).abs();
                if diff > worst_eval {
                    worst_eval = diff;
                }
                if diff > 1e-6 {
                    eval_mm += 1;
                    if eval_mm <= 3 {
                        eprintln!("EVAL mismatch at {}: rust={} js={} diff={}", key, got, exp_eval, diff);
                    }
                }
            }
            println!(
                "{}: {} positions | move mismatches={} | key mismatches={} | eval mismatches={} (worst abs diff={:.2e})",
                args[0], n, move_mm, key_mm, eval_mm, worst_eval
            );
            if move_mm + key_mm + eval_mm > 0 {
                std::process::exit(1);
            }
        }
        "perftv" => {
            // perftv <variant> <depth> <expected>  — assert perft equals expected
            let e = get_engine(&args[0]);
            let depth: u32 = args[1].parse().unwrap();
            let expected: u64 = args[2].parse().unwrap();
            let mut st = e.initial_state();
            let got = e.perft(&mut st, depth);
            let ok = got == expected;
            println!("{} perft({}) = {} (expected {}) {}", args[0], depth, got, expected,
                     if ok { "OK" } else { "FAIL" });
            if !ok {
                std::process::exit(1);
            }
        }
        "bestmove" => {
            // bestmove <variant> (--key <k>|--start) [--time <ms>]  — for head-to-head.
            let e = get_engine(&args[0]);
            let mut st = state_from_args(&e, args);
            let time_ms: u64 = flag(args, "--time").and_then(|s| s.parse().ok()).unwrap_or(200);
            let mut s = Searcher::new(&e);
            s.max_depth = 64;
            s.time_ms = time_ms;
            let mut tt = TT::new();
            let (m, sc, d) = s.search_best(&mut st, &mut tt);
            match m {
                Some(mv) => println!("{}\t{}\t{:.1}\t{}", mv.id(), e.san_of(&st, &mv), sc, d),
                None => println!("none"),
            }
        }
        "genbook" => {
            // genbook <variant> [--plies N] [--depth D] [--top K] [--out DIR] [--shards N]
            let e = get_engine(&args[0]);
            // Directory + manifest are keyed by the canonical variant id
            // (tinyhouse/minihouse/gardner), matching the JS config `id` so the
            // browser looks the book up under the same name.
            let variant = e.cfg.id.clone();
            let plies: usize = flag(args, "--plies").and_then(|s| s.parse().ok()).unwrap_or(8);
            let depth: i32 = flag(args, "--depth").and_then(|s| s.parse().ok()).unwrap_or(8);
            let topk: usize = flag(args, "--top").and_then(|s| s.parse().ok()).unwrap_or(10);
            let outroot = flag(args, "--out").unwrap_or("../chesslib/books").to_string();
            let forced_shards: Option<u32> = flag(args, "--shards").and_then(|s| s.parse().ok());
            // Budget caps: BFS covers shallow plies first, so a cap yields a clean
            // "complete up to a frontier" book. Stop when either is hit.
            let maxpos: u64 = flag(args, "--maxpos").and_then(|s| s.parse().ok()).unwrap_or(u64::MAX);
            let budget_s: f64 = flag(args, "--budget").and_then(|s| s.parse().ok()).unwrap_or(f64::MAX);

            let mut s = Searcher::new(&e);
            let mut tt = TT::new();
            let mut book: Vec<(String, Vec<(String, i64)>)> = Vec::new();
            let mut visited: HashSet<String> = HashSet::new();
            let mut q: VecDeque<(State, usize)> = VecDeque::new();

            let start = e.initial_state();
            let start_key = e.key(&start);
            visited.insert(start_key.clone());
            q.push_back((start, 0));

            let t0 = Instant::now();
            let mut count: u64 = 0;
            let mut stopped_early = false;
            let mut max_booked_ply = 0usize;
            let mut frontier_ply = plies + 1; // ply of first unprocessed queue item on stop
            while let Some((mut st, ply)) = q.pop_front() {
                if count >= maxpos || t0.elapsed().as_secs_f64() >= budget_s {
                    stopped_early = true;
                    frontier_ply = ply;
                    break;
                }
                if ply > max_booked_ply {
                    max_booked_ply = ply;
                }
                let ranked = s.analyze_all(&mut st, depth, &mut tt);
                if ranked.is_empty() {
                    continue; // terminal — no move to book
                }
                let stm_sign = if st.turn == WHITE { 1.0 } else { -1.0 };
                let key = e.key(&st);
                let mut arr: Vec<(String, i64)> = Vec::with_capacity(ranked.len());
                for (m, sc) in &ranked {
                    let cp = (stm_sign * sc).round() as i64;
                    arr.push((e.san_of(&st, m), cp));
                }
                book.push((key, arr));
                count += 1;
                if ply < plies {
                    for (m, _) in ranked.iter().take(topk) {
                        let u = e.make_move(&mut st, *m);
                        let ck = e.key(&st);
                        if !visited.contains(&ck) {
                            visited.insert(ck.clone());
                            q.push_back((st.clone(), ply + 1));
                        }
                        e.unmake_move(&mut st, &u);
                    }
                }
                if count % 200 == 0 {
                    let secs = t0.elapsed().as_secs_f64();
                    eprintln!(
                        "[{}] booked={} queue={} {:.1}s ({:.1}/s) ttSize={} hit={:.1}%",
                        variant, count, q.len(), secs, count as f64 / secs.max(0.001),
                        tt.map.len(), 100.0 * tt.hits as f64 / (tt.probes.max(1) as f64)
                    );
                }
            }
            let dt = t0.elapsed().as_secs_f64();

            let dir = format!("{}/{}", outroot, variant);
            std::fs::create_dir_all(&dir).expect("create book dir");

            // Sharding — matches chesslib/book.js, which routes a key to the
            // shard whose id is the longest listed PREFIX of the key, and which
            // explicitly supports a single catch-all "" shard.
            //
            //  * Small book (<= ~1.8 MB): ONE catch-all shard, id "" -> file
            //    ".json". This is the robust default: no case-conflicting
            //    filenames (keys carry piece color as letter-case, so prefix
            //    shards like D.json/d.json collide on case-insensitive / Dropbox
            //    filesystems). Per the task, sharding is only needed above ~2 MB.
            //  * Large book: fall back to FIRST-CHARACTER prefix shards
            //    ("<letter>.json" / "..json"); '*' never appears at index 0.
            let _ = forced_shards;
            let est_bytes: usize = book
                .iter()
                .map(|(k, arr)| k.len() + 8 + arr.iter().map(|(sn, _)| sn.len() + 20).sum::<usize>())
                .sum();
            const SINGLE_SHARD_MAX: usize = 1_800_000;

            let mut total_bytes: u64 = 0;
            let mut shard_ids: Vec<String> = Vec::new();
            if est_bytes <= SINGLE_SHARD_MAX {
                let mut buf = String::from("{");
                for (i, (key, arr)) in book.iter().enumerate() {
                    if i > 0 {
                        buf.push(',');
                    }
                    buf.push_str(&format!("\"{}\":{}", key, moves_json(arr)));
                }
                buf.push('}');
                std::fs::write(format!("{}/.json", dir), buf.as_bytes()).expect("write shard");
                total_bytes += buf.len() as u64;
                shard_ids.push(String::new());
            } else {
                use std::collections::BTreeMap;
                let mut shards: BTreeMap<char, String> = BTreeMap::new();
                for (key, arr) in &book {
                    let id = key.chars().next().expect("non-empty key");
                    let buf = shards.entry(id).or_insert_with(String::new);
                    if buf.is_empty() {
                        buf.push('{');
                    } else {
                        buf.push(',');
                    }
                    buf.push_str(&format!("\"{}\":{}", key, moves_json(arr)));
                }
                for (id, buf) in shards.iter_mut() {
                    buf.push('}');
                    let ids: String = id.to_string();
                    std::fs::write(format!("{}/{}.json", dir, ids), buf.as_bytes())
                        .expect("write shard");
                    total_bytes += buf.len() as u64;
                    shard_ids.push(ids);
                }
            }
            let shard_count = shard_ids.len();

            // Plies fully enumerated: if we drained the queue, min(plies, deepest booked);
            // if we stopped early, everything up to frontier_ply-1 is complete.
            let full_plies = if stopped_early {
                frontier_ply.saturating_sub(1)
            } else {
                max_booked_ply
            };
            let hit_pct = 100.0 * tt.hits as f64 / (tt.probes.max(1) as f64);
            // shard-id JSON array (ids are single board chars: letters or '.', JSON-safe).
            let shards_json: String = {
                let items: Vec<String> = shard_ids.iter().map(|s| format!("\"{}\"", s)).collect();
                format!("[{}]", items.join(","))
            };
            // Manifest matches chesslib/book.js's contract: it requires a `shards`
            // ARRAY (of key-prefix shard ids). Extra fields are informational.
            let manifest = format!(
                "{{\"variant\":\"{}\",\"engineVersion\":\"{}\",\"plies\":{},\"depth\":{},\
\"positions\":{},\"shards\":{},\
\"targetPlies\":{},\"fullyCoveredPlies\":{},\"deepestBookedPly\":{},\"stoppedEarly\":{},\"topK\":{},\
\"startKey\":\"{}\",\"shardScheme\":\"book.js longest-prefix routing: key -> shard whose id is the longest listed prefix of key; shard file = <id>.json. Single catch-all id \\\"\\\" (file .json) for books <=1.8MB, else first-character prefixes.\",\
\"schema\":\"shard file = {{ key(): [{{san,cp}}, ...] }}; cp is white-relative centipawns (int); array sorted best-for-side-to-move first; SAN matches chesslib/pgn.js\",\
\"ttSize\":{},\"ttProbes\":{},\"ttHits\":{},\"ttHitPct\":{:.2},\"buildSeconds\":{:.1}}}",
                variant, ENGINE_VERSION, full_plies, depth, count, shards_json,
                plies, full_plies, max_booked_ply, stopped_early, topk,
                start_key, tt.map.len(), tt.probes, tt.hits, hit_pct, dt
            );
            std::fs::write(format!("{}/manifest.json", dir), manifest.as_bytes())
                .expect("write manifest");

            eprintln!(
                "[{}] DONE positions={} plies={} depth={} top={} shards={} bytes={} {:.1}s ttHit={:.1}% ({}/{})",
                variant, count, plies, depth, topk, shard_count, total_bytes, dt, hit_pct, tt.hits, tt.probes
            );
        }
        "bench" => {
            // Fixed-depth nodes/sec benchmark from the start position.
            let e = get_engine(&args[0]);
            let depth: i32 = flag(args, "--depth").and_then(|s| s.parse().ok()).unwrap_or(6);
            let time_ms: u64 = flag(args, "--time").and_then(|s| s.parse().ok()).unwrap_or(0);
            let mut st = e.initial_state();
            let mut s = Searcher::new(&e);
            s.max_depth = if time_ms > 0 { 64 } else { depth };
            s.time_ms = time_ms;
            let mut tt = TT::new();
            let t = Instant::now();
            let (m, sc, d) = s.search_best(&mut st, &mut tt);
            let dt = t.elapsed().as_secs_f64();
            let nps = s.nodes() as f64 / dt;
            println!("{} bench depth={} best={} score={:.1} nodes={} time={:.3}s nps={:.0}",
                     args[0], d,
                     m.map(|mm| e.san_of(&st, &mm)).unwrap_or_default(),
                     sc, s.nodes(), dt, nps);
            let _ = d;
        }
        _ => {
            eprintln!("unknown command: {}", cmd);
            std::process::exit(2);
        }
    }
    let _: Option<Move> = None;
}
