//! Read-only import directory discovery. Ambiguous matches are never selected.
use serde::Serialize;
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Seek},
    path::Path,
};

#[derive(Debug, Serialize)]
pub struct Suggestion {
    pub from: String,
    pub suggested: Option<String>,
    pub candidates: Vec<String>,
}

fn key(s: &str) -> String {
    let s = display_path(s)
        .trim_end_matches(['/', '\\'])
        .replace('\\', "/");
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

fn display_path(s: &str) -> String {
    if let Some(rest) = s.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{rest}");
    }
    s.strip_prefix("\\\\?\\").unwrap_or(s).to_string()
}

fn leaf(s: &str) -> String {
    s.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_lowercase()
}

fn choose(source: &str, candidates: &[String]) -> Option<String> {
    let exact: Vec<_> = candidates
        .iter()
        .filter(|c| key(c) == key(source))
        .collect();
    if exact.len() == 1 {
        return Some(exact[0].clone());
    }
    let matches: Vec<_> = candidates
        .iter()
        .filter(|c| leaf(c) == leaf(source))
        .collect();
    if matches.len() == 1 {
        Some(matches[0].clone())
    } else {
        None
    }
}

fn source_dirs<R: Read + Seek>(
    reader: R,
    nested: bool,
    dirs: &mut BTreeSet<String>,
    budget: &mut u64,
) -> Result<(), String> {
    let mut z = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;
    if let Ok(mut f) = z.by_name("manifest.json") {
        if f.size() > 5 * 1024 * 1024 {
            return Err("导出包清单过大".into());
        }
        let mut bytes = Vec::new();
        (&mut f)
            .take(5 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 5 * 1024 * 1024 {
            return Err("导出包清单过大".into());
        }
        let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if let Some(cwd) = v["codex"]["cwd"].as_str().filter(|s| !s.trim().is_empty()) {
            dirs.insert(cwd.into());
        }
        return Ok(());
    }
    if nested {
        return Err("内部导出包缺少 manifest.json".into());
    }
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        if !f.name().to_lowercase().ends_with(".zip") {
            continue;
        }
        let limit = (*budget).min(256 * 1024 * 1024);
        if f.size() > limit {
            return Err("导出包过大，请分批识别路径".into());
        }
        let mut bytes = Vec::new();
        (&mut f)
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > limit {
            return Err("导出包过大，请分批识别路径".into());
        }
        *budget -= bytes.len() as u64;
        source_dirs(std::io::Cursor::new(bytes), true, dirs, budget)?;
    }
    Ok(())
}

pub fn detect(home: &Path, bundles: &[String]) -> Result<Vec<Suggestion>, String> {
    let mut dirs = BTreeSet::new();
    let mut budget = 2 * 1024 * 1024 * 1024u64;
    for path in bundles {
        source_dirs(
            fs::File::open(path).map_err(|e| e.to_string())?,
            false,
            &mut dirs,
            &mut budget,
        )?;
    }
    let mut local = BTreeSet::new();
    let mut dbs: Vec<_> = fs::read_dir(home)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let version = name
                .strip_prefix("state_")?
                .strip_suffix(".sqlite")?
                .parse::<u32>()
                .ok()?;
            Some((version, e.path()))
        })
        .collect();
    dbs.sort_by_key(|(v, _)| std::cmp::Reverse(*v));
    if let Some((_, db)) = dbs.first() {
        if let Ok(conn) =
            rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        {
            for sql in [
                "SELECT path FROM project_roots",
                "SELECT DISTINCT cwd FROM threads",
            ] {
                if let Ok(mut stmt) = conn.prepare(sql) {
                    if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                        local.extend(rows.flatten());
                    }
                }
            }
        }
    }
    if let Ok(text) = fs::read_to_string(home.join("config.toml")) {
        if let Ok(doc) = text.parse::<toml_edit::DocumentMut>() {
            if let Some(projects) = doc.get("projects").and_then(|v| v.as_table()) {
                local.extend(projects.iter().map(|(k, _)| k.to_string()));
            }
        }
    }
    if let Ok(text) = fs::read_to_string(home.join(".codex-global-state.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            for key in ["electron-saved-workspace-roots", "active-workspace-roots"] {
                if let Some(arr) = v[key].as_array() {
                    local.extend(arr.iter().filter_map(|v| v.as_str().map(str::to_string)));
                }
            }
        }
    }
    local.extend(
        dirs.iter()
            .filter(|s| Path::new(s).is_absolute() && Path::new(s).is_dir())
            .cloned(),
    );
    let mut seen = BTreeSet::new();
    let candidates: Vec<_> = local
        .into_iter()
        .map(|s| display_path(&s))
        .filter(|s| Path::new(s).is_absolute() && Path::new(s).is_dir() && seen.insert(key(s)))
        .collect();
    Ok(dirs
        .into_iter()
        .map(|from| Suggestion {
            suggested: choose(&from, &candidates),
            from,
            candidates: candidates.clone(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_cross_platform_and_refuses_ambiguity() {
        assert_eq!(
            key("\\\\?\\C:\\project\\course"),
            key("C:\\project\\course")
        );
        let mut candidates = vec!["C:\\project\\course".into()];
        assert_eq!(
            choose("/Users/a/course", &candidates),
            Some(candidates[0].clone())
        );
        candidates.push("D:\\another\\course".into());
        assert_eq!(choose("/Users/a/course", &candidates), None);
        assert_eq!(
            choose("C:\\project\\course", &candidates),
            Some(candidates[0].clone())
        );
        assert_eq!(choose("/Users/a/unknown", &candidates), None);
    }

    #[test]
    fn detects_nested_bundle_without_extracting_rollouts() {
        use std::io::{Cursor, Write};
        fn zip(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
            let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
            for (name, bytes) in entries {
                out.start_file(*name, zip::write::FileOptions::default())
                    .unwrap();
                out.write_all(bytes).unwrap();
            }
            out.finish().unwrap().into_inner()
        }
        let manifest = br#"{"codex":{"cwd":"/old/course"}}"#.to_vec();
        let inner = zip(&[("manifest.json", manifest)]);
        let outer = zip(&[
            ("bundles/one.zip", inner.clone()),
            ("bundles/two.zip", inner),
        ]);
        let mut dirs = BTreeSet::new();
        source_dirs(Cursor::new(outer), false, &mut dirs, &mut 1024_000).unwrap();
        assert_eq!(dirs, BTreeSet::from(["/old/course".to_string()]));
        let bad = zip(&[("bundles/bad.zip", zip(&[]))]);
        assert!(source_dirs(Cursor::new(bad), false, &mut dirs, &mut 1024_000).is_err());
    }
}
