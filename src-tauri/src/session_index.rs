//! 导入后把会话登记到 Codex 的 `session_index.jsonl`。
//!
//! Codex CLI 的会话列表读的是 `CODEX_HOME/session_index.jsonl`，每行：
//! `{"id": "...", "thread_name": "...", "updated_at": "..."}`。
//! 只把 rollout 文件拷进 `sessions/` 目录而不登记，会话在 Codex UI 列表里
//! 不会出现（`codex resume <id>` 仍可用）。
//!
//! 这里只做**追加**：
//! - 更新名称时追加新记录，以最后一条为准，不覆盖、不删除任何已有行；
//! - 天然满足"B 机独有会话原样保留"的要求。

use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::Path,
};

#[derive(Debug, Serialize)]
pub struct IndexEntry {
    pub id: String,
    pub thread_name: String,
    pub updated_at: String,
}

/// 检查 session_index.jsonl 中是否已存在给定 id 的记录。
#[cfg(test)]
fn has_id(index_path: &Path, id: &str) -> Result<bool, String> {
    if !index_path.exists() {
        return Ok(false);
    }
    let f = fs::File::open(index_path).map_err(|e| format!("open session_index: {e}"))?;
    let reader = BufReader::new(f);
    for line in reader.lines() {
        let line = line.map_err(|e| format!("read session_index: {e}"))?;
        let line = line.trim().trim_start_matches('\u{feff}');
        if line.is_empty() {
            continue;
        }
        // 只取 id 字段，容忍其他行格式异常。
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if v.pointer("/id").and_then(|x| x.as_str()) == Some(id) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// 追加一条会话索引。返回值：是否实际写入了新行。
/// 若文件不存在则创建。
#[cfg(test)]
pub fn append_session_index(
    codex_home: &Path,
    id: &str,
    thread_name: &str,
) -> Result<bool, String> {
    let index_path = codex_home.join("session_index.jsonl");

    if has_id(&index_path, id)? {
        return Ok(false);
    }

    let entry = IndexEntry {
        id: id.to_string(),
        thread_name: thread_name.to_string(),
        // 沿用项目已有的 RFC3339 UTC 时间格式。
        updated_at: crate::bundle::now_rfc3339_utc()?,
    };
    let line = serde_json::to_string(&entry).map_err(|e| format!("serialize index entry: {e}"))?;

    // 若索引文件已存在但最后一行没有以换行结尾（很常见），直接 append 会把新记录
    // 拼到最后一行尾部，形成一条无法解析的 JSON，既损坏原有最后一行，也会让后续的
    // 去重检测漏掉新写入的 id。这里先读出末尾字节，必要时补一个换行。
    let need_leading_newline = fs::read(&index_path)
        .map(|bytes| matches!(bytes.last(), Some(last) if *last != b'\n'))
        .unwrap_or(false);

    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&index_path)
        .map_err(|e| format!("open session_index for append: {e}"))?;
    if need_leading_newline {
        f.write_all(b"\n")
            .map_err(|e| format!("separate previous session_index line: {e}"))?;
    }
    writeln!(f, "{line}").map_err(|e| format!("append session_index: {e}"))?;
    Ok(true)
}

pub fn upsert_session_title(
    codex_home: &Path,
    id: &str,
    thread_name: &str,
) -> Result<bool, String> {
    if read_title_map(codex_home).get(id).map(String::as_str) == Some(thread_name) {
        return Ok(false);
    }
    // Last entry wins. Append without overwriting concurrent Codex index writes.
    let index_path = codex_home.join("session_index.jsonl");
    let previous = match fs::read(&index_path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.to_string()),
    };
    let separator = if matches!(previous.last(), Some(b) if *b != b'\n') {
        "\n"
    } else {
        ""
    };
    let entry = IndexEntry {
        id: id.into(),
        thread_name: thread_name.into(),
        updated_at: crate::bundle::now_rfc3339_utc()?,
    };
    let text = format!(
        "{}{}\n",
        separator,
        serde_json::to_string(&entry).map_err(|e| e.to_string())?
    );
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(index_path)
        .and_then(|mut f| f.write_all(text.as_bytes()))
        .map_err(|e| format!("append session title: {e}"))?;
    Ok(true)
}

/// Explicit Desktop names override the index; first-message titles are a last resort.
pub fn read_thread_titles(codex_home: &Path) -> HashMap<String, String> {
    let mut titles = read_title_map(codex_home);
    let Ok(entries) = fs::read_dir(codex_home) else {
        return titles;
    };
    let mut dbs: Vec<_> = entries
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
    for (_, path) in dbs {
        let Ok(conn) =
            rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        else {
            continue;
        };
        let Ok(mut query) = conn.prepare("SELECT id, name, title FROM threads") else {
            continue;
        };
        let Ok(rows) = query.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
            ))
        }) else {
            continue;
        };
        for (id, name, title) in rows.flatten() {
            if let Some(name) = name.filter(|s| !s.trim().is_empty()) {
                titles.insert(id, name);
            } else if !title.trim().is_empty() {
                titles.entry(id).or_insert(title);
            }
        }
        break;
    }
    titles
}

/// 读取整个 session_index.jsonl，建立 `id -> thread_name（标题）` 映射。
///
/// - 文件不存在或为空时返回空 map（不是错误，老版本 Codex 可能没有索引）；
/// - 同一 id 出现多行时以**最后一行**为准（Codex 可能更新过标题）；
/// - thread_name 为空字符串的条目不覆盖已有标题；
/// - 任何单行解析失败都跳过，不影响其他行。
pub fn read_title_map(codex_home: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let index_path = codex_home.join("session_index.jsonl");
    let Ok(f) = fs::File::open(index_path) else {
        return map;
    };
    let reader = BufReader::new(f);
    for line in reader.lines().flatten() {
        let line = line.trim().trim_start_matches('\u{feff}');
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(id) = v.pointer("/id").and_then(|x| x.as_str()) else {
            continue;
        };
        if let Some(name) = v.pointer("/thread_name").and_then(|x| x.as_str()) {
            let name = name.trim();
            if !name.is_empty() {
                map.insert(id.to_string(), name.to_string());
            }
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("codexrelay-si-{}-{}", tag, uuid::Uuid::now_v7()))
    }

    #[test]
    fn appends_when_missing_and_dedupes_when_exists() {
        let home = temp_home("append");
        fs::create_dir_all(&home).unwrap();
        let idx = home.join("session_index.jsonl");
        fs::write(
            &idx,
            r#"{"id":"existing","thread_name":"old","updated_at":"2026-01-01T00:00:00Z"}"#,
        )
        .unwrap();

        // 新 id：追加。
        assert!(append_session_index(&home, "new-id", "我的导入").unwrap());
        // 再追加同 id：跳过。
        assert!(!append_session_index(&home, "new-id", "我的导入").unwrap());

        let text = fs::read_to_string(&idx).unwrap();
        let lines: Vec<&str> = text.trim_end().split('\n').collect();
        assert_eq!(lines.len(), 2, "existing line must be preserved");
        assert!(lines[0].contains("\"id\":\"existing\""));
        assert!(lines[1].contains("\"id\":\"new-id\""));
        assert!(lines[1].contains("我的导入"));

        // 已存在的 id 不新增行。
        assert!(!append_session_index(&home, "existing", "x").unwrap());
        let text = fs::read_to_string(&idx).unwrap();
        let lines: Vec<&str> = text.trim_end().split('\n').collect();
        assert_eq!(lines.len(), 2);

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn newest_duplicate_title_wins_without_rewriting_existing_bytes() {
        let home = temp_home("duplicates");
        fs::create_dir_all(&home).unwrap();
        let path = home.join("session_index.jsonl");
        let before = "\u{feff}{\"id\":\"a\",\"thread_name\":\"first\"}\n{\"id\":\"a\",\"thread_name\":\"stale\"}\nmalformed";
        fs::write(&path, before).unwrap();
        assert!(upsert_session_title(&home, "a", "原始会话标题").unwrap());
        assert_eq!(read_title_map(&home)["a"], "原始会话标题");
        assert!(fs::read_to_string(&path).unwrap().starts_with(before));
        let bytes = fs::read(&path).unwrap();
        assert!(!upsert_session_title(&home, "a", "原始会话标题").unwrap());
        assert_eq!(fs::read(path).unwrap(), bytes);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn explicit_catalog_name_wins_over_first_message_and_stale_index() {
        let home = temp_home("catalog");
        fs::create_dir_all(&home).unwrap();
        upsert_session_title(&home, "a", "outdated").unwrap();
        upsert_session_title(&home, "b", "indexed title").unwrap();
        let conn = rusqlite::Connection::open(home.join("state_5.sqlite")).unwrap();
        conn.execute_batch("CREATE TABLE threads(id TEXT,name TEXT,title TEXT); INSERT INTO threads VALUES ('a','chosen title','first message'),('b',NULL,'long first message'),('c',NULL,'only available title');").unwrap();
        let titles = read_thread_titles(&home);
        assert_eq!(titles["a"], "chosen title");
        assert_eq!(titles["b"], "indexed title");
        assert_eq!(titles["c"], "only available title");
        drop(conn);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn creates_index_file_when_absent() {
        let home = temp_home("create");
        fs::create_dir_all(&home).unwrap();
        assert!(append_session_index(&home, "only", "t").unwrap());
        let text = fs::read_to_string(home.join("session_index.jsonl")).unwrap();
        assert!(text.contains("\"id\":\"only\""));
        let _ = fs::remove_dir_all(&home);
    }
}
