//! Read-only path discovery: HOME BUNDLE [BUNDLE...].
#[path = "../src/path_detection.rs"]
mod path_detection;
fn main() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        return Err("HOME BUNDLE [BUNDLE...]".into());
    }
    let result = path_detection::detect(std::path::Path::new(&args[0]), &args[1..])?;
    println!(
        "{}",
        serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?
    );
    Ok(())
}
