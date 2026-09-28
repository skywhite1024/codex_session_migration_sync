//! Offline diagnostic helper. Writes only the specified output, never CODEX_HOME.
//! cargo run --example materialize_history -- HOME INPUT OUTPUT [FROM TO NEW_ID]
#[path = "../src/history.rs"]
mod history;
#[path = "../src/path_rewrite.rs"]
mod path_rewrite;
use std::path::Path;
fn main() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 3 && args.len() != 6 {
        return Err("HOME INPUT OUTPUT [FROM TO NEW_ID]".into());
    }
    let dst = Path::new(&args[2]);
    if dst.exists() {
        return Err("Output already exists".into());
    }
    if args.len() == 3 {
        return history::export_standalone(Path::new(&args[0]), Path::new(&args[1]), dst);
    }
    let tmp = dst.with_extension("standalone");
    if tmp.exists() {
        return Err("Temporary output already exists".into());
    }
    history::export_standalone(Path::new(&args[0]), Path::new(&args[1]), &tmp)?;
    let first = std::io::BufRead::lines(std::io::BufReader::new(
        std::fs::File::open(&tmp).map_err(|e| e.to_string())?,
    ))
    .next()
    .ok_or("Empty rollout")?
    .map_err(|e| e.to_string())?;
    let meta: serde_json::Value = serde_json::from_str(&first).map_err(|e| e.to_string())?;
    let result = path_rewrite::rewrite_rollout(
        &tmp,
        dst,
        Some(&args[5]),
        meta["payload"]["id"].as_str().ok_or("No ID")?,
        &[path_rewrite::PathRewrite {
            from: args[3].clone(),
            to: args[4].clone(),
        }],
    );
    let _ = std::fs::remove_file(tmp);
    result
}
