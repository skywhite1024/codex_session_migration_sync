use serde::Serialize;
use std::{
    fs,
    io::{self, BufRead, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone)]
pub struct DetectedCodexHome {
    pub path: PathBuf,
    pub source: String, // "env" | "default"
}

pub fn detect_codex_home() -> DetectedCodexHome {
    if let Some(path) = std::env::var_os("CODEX_HOME") {
        return DetectedCodexHome {
            path: PathBuf::from(path),
            source: "env".to_string(),
        };
    }

    let home = home_dir().unwrap_or_else(|| PathBuf::from("."));
    DetectedCodexHome {
        path: home.join(".codex"),
        source: "default".to_string(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSummary {
    pub id: String,
    /// Codex 会话列表里显示的标题（session_index.jsonl 的 thread_name），老会话可能为 None。
    pub title: Option<String>,
    pub rollout_path: String,
    pub cwd: Option<String>,
    pub cli_version: Option<String>,
    pub model_provider: Option<String>,
    pub mtime_ms: Option<i64>,
    pub last_event_timestamp: Option<String>,
    pub file_size: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct RolloutMeta {
    pub id: String,
    pub cwd: Option<String>,
    pub cli_version: Option<String>,
    pub model_provider: Option<String>,
    pub rollout_rel_path: Option<String>,
    pub rollout_file_name: Option<String>,
}

pub fn read_rollout_meta(codex_home: &Path, rollout_path: &Path) -> Result<RolloutMeta, String> {
    let f = fs::File::open(rollout_path).map_err(|e| format!("open rollout: {e}"))?;
    let mut reader = io::BufReader::new(f);
    let mut first_line = String::new();
    reader
        .read_line(&mut first_line)
        .map_err(|e| format!("read rollout: {e}"))?;

    let first_line = first_line.trim_end();
    if first_line.is_empty() {
        return Err("empty rollout".to_string());
    }

    let v: serde_json::Value =
        serde_json::from_str(first_line).map_err(|e| format!("parse first json line: {e}"))?;
    let id = v
        .pointer("/payload/id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "缺少 payload.id".to_string())?
        .to_string();

    let cwd = v
        .pointer("/payload/cwd")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let cli_version = v
        .pointer("/payload/cli_version")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let model_provider = v
        .pointer("/payload/model_provider")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());

    let rollout_rel_path = codex_rel_path(codex_home, rollout_path);
    let rollout_file_name = rollout_path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());

    Ok(RolloutMeta {
        id,
        cwd,
        cli_version,
        model_provider,
        rollout_rel_path,
        rollout_file_name,
    })
}

pub fn list_sessions(codex_home: &Path, limit: usize) -> Vec<SessionSummary> {
    let sessions_root = codex_home.join("sessions");
    if !sessions_root.exists() {
        return Vec::new();
    }

    // First collect candidates with only cheap filesystem metadata, then parse only the newest N.
    // This avoids reading tail windows from thousands of old rollouts.
    let mut candidates: Vec<(Option<i64>, PathBuf)> = Vec::new();
    for entry in walkdir::WalkDir::new(&sessions_root)
        .follow_links(false)
        .into_iter()
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if !file_name.starts_with("rollout-") {
            continue;
        }
        let meta = fs::metadata(path).ok();
        let mtime_ms = meta
            .and_then(|m| m.modified().ok())
            .and_then(system_time_to_ms);
        candidates.push((mtime_ms, path.to_path_buf()));
    }

    candidates.sort_by(|a, b| b.0.cmp(&a.0));

    // 读一次会话索引，拿到 id -> 标题（thread_name）映射。
    let title_map = crate::session_index::read_title_map(codex_home);

    let mut out: Vec<SessionSummary> = Vec::new();
    for (_t, path) in candidates {
        if out.len() >= limit {
            break;
        }
        if let Ok(mut summary) = parse_rollout_summary(&path) {
            summary.title = title_map.get(&summary.id).cloned();
            out.push(summary);
        }
    }
    out
}

pub fn find_rollout_by_session_id(
    codex_home: &Path,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    let sessions_root = codex_home.join("sessions");
    if !sessions_root.exists() {
        return Ok(None);
    }

    let mut best: Option<(Option<i64>, PathBuf)> = None;

    for entry in walkdir::WalkDir::new(&sessions_root)
        .follow_links(false)
        .into_iter()
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if !file_name.starts_with("rollout-") || !file_name.ends_with(".jsonl") {
            continue;
        }
        if !file_name.contains(session_id) {
            continue;
        }

        let meta = fs::metadata(path).ok();
        let mtime_ms = meta
            .and_then(|m| m.modified().ok())
            .and_then(system_time_to_ms);
        let candidate = (mtime_ms, path.to_path_buf());
        if let Some((best_mtime, _)) = &best {
            if candidate.0 > *best_mtime {
                best = Some(candidate);
            }
        } else {
            best = Some(candidate);
        }
    }

    Ok(best.map(|(_, p)| p))
}

pub fn codex_rel_path(codex_home: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(codex_home).ok()?;
    Some(path_to_slash_string(rel))
}

pub fn safe_join_codex_home(codex_home: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("相对路径不能是绝对路径".to_string());
    }
    for c in rel_path.components() {
        if matches!(c, Component::ParentDir) {
            return Err("相对路径不能包含 '..'".to_string());
        }
    }
    Ok(codex_home.join(rel_path))
}

fn parse_rollout_summary(path: &Path) -> Result<SessionSummary, String> {
    let f = fs::File::open(path).map_err(|e| format!("open rollout: {e}"))?;
    let mut reader = io::BufReader::new(f);
    let mut first_line = String::new();
    reader
        .read_line(&mut first_line)
        .map_err(|e| format!("read rollout: {e}"))?;

    let first_line = first_line.trim_end();
    if first_line.is_empty() {
        return Err("empty rollout".to_string());
    }

    let v: serde_json::Value =
        serde_json::from_str(first_line).map_err(|e| format!("parse first json line: {e}"))?;
    let id = v
        .pointer("/payload/id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "缺少 payload.id".to_string())?
        .to_string();

    let cwd = v
        .pointer("/payload/cwd")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let cli_version = v
        .pointer("/payload/cli_version")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let model_provider = v
        .pointer("/payload/model_provider")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());

    let meta = fs::metadata(path).ok();
    let file_size = meta.as_ref().and_then(|m| i64::try_from(m.len()).ok());
    let mtime_ms = meta
        .and_then(|m| m.modified().ok())
        .and_then(system_time_to_ms);

    let last_event_timestamp = read_last_event_timestamp(path).ok().flatten();

    Ok(SessionSummary {
        id,
        title: None,
        rollout_path: path.to_string_lossy().to_string(),
        cwd,
        cli_version,
        model_provider,
        mtime_ms,
        last_event_timestamp,
        file_size,
    })
}

pub fn read_rollout_session_id(path: &Path) -> Result<String, String> {
    let f = fs::File::open(path).map_err(|e| format!("open rollout: {e}"))?;
    let mut reader = io::BufReader::new(f);
    let mut first_line = String::new();
    reader
        .read_line(&mut first_line)
        .map_err(|e| format!("read rollout: {e}"))?;
    let first_line = first_line.trim_end();
    let v: serde_json::Value =
        serde_json::from_str(first_line).map_err(|e| format!("parse first json line: {e}"))?;
    Ok(v.pointer("/payload/id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "缺少 payload.id".to_string())?
        .to_string())
}

pub fn read_last_event_timestamp(path: &Path) -> Result<Option<String>, String> {
    let last_line = read_last_non_empty_line(path)?;
    let Some(line) = last_line else {
        return Ok(None);
    };
    let v: serde_json::Value =
        serde_json::from_str(&line).map_err(|e| format!("parse last json line: {e}"))?;
    Ok(v.get("timestamp")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string()))
}

fn read_last_non_empty_line(path: &Path) -> Result<Option<String>, String> {
    let mut f = fs::File::open(path).map_err(|e| format!("open file: {e}"))?;
    let size = f.metadata().map_err(|e| format!("stat file: {e}"))?.len();
    if size == 0 {
        return Ok(None);
    }

    // Read a tail chunk. JSONL last line is typically small; 256 KiB is plenty.
    let chunk_size: u64 = 256 * 1024;
    let start = size.saturating_sub(chunk_size);
    f.seek(SeekFrom::Start(start))
        .map_err(|e| format!("seek file: {e}"))?;

    let mut buf = Vec::new();
    f.read_to_end(&mut buf)
        .map_err(|e| format!("read file tail: {e}"))?;

    // Find last non-empty line.
    let mut end = buf.len();
    while end > 0 && (buf[end - 1] == b'\n' || buf[end - 1] == b'\r') {
        end -= 1;
    }
    if end == 0 {
        return Ok(None);
    }

    let mut i = end;
    while i > 0 {
        if buf[i - 1] == b'\n' {
            break;
        }
        i -= 1;
    }
    let line_bytes = &buf[i..end];
    let line =
        String::from_utf8(line_bytes.to_vec()).map_err(|e| format!("utf8 tail line: {e}"))?;
    let line = line.trim_end().to_string();
    if line.is_empty() {
        return Ok(None);
    }
    Ok(Some(line))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

fn system_time_to_ms(t: SystemTime) -> Option<i64> {
    let dur = t.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(dur.as_millis()).ok()
}

fn path_to_slash_string(path: &Path) -> String {
    let mut s = String::new();
    for (i, c) in path.components().enumerate() {
        if i > 0 {
            s.push('/');
        }
        match c {
            Component::Normal(p) => s.push_str(&p.to_string_lossy()),
            Component::CurDir => s.push('.'),
            Component::RootDir => s.push('/'),
            Component::ParentDir => s.push_str(".."),
            Component::Prefix(p) => s.push_str(&p.as_os_str().to_string_lossy()),
        }
    }
    s
}
