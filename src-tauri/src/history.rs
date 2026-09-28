//! Materialize paginated lineage before a rollout leaves its source machine.
//! Byte offsets refer to the ORIGINAL files: resolve them before path/ID rewrites.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
};

const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_DEPTH: usize = 64;

fn metadata(path: &Path) -> Result<Value, String> {
    let mut line = String::new();
    BufReader::new(File::open(path).map_err(|e| e.to_string())?)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&line).map_err(|e| format!("会话元数据无效：{e}"))?;
    if v["type"] != "session_meta" || v["payload"]["id"].as_str().is_none() {
        return Err("会话缺少 session_meta.id".into());
    }
    Ok(v)
}

/// Older standalone bundles remain supported. Dependent bundles must be re-exported
/// from the source; resolving against the destination would silently use stale parents.
pub fn validate_standalone(path: &Path) -> Result<(), String> {
    let meta = metadata(path)?;
    if !meta["payload"]["history_base"].is_null() || meta["ordinal"].as_u64().unwrap_or(0) != 0 {
        return Err("会话仍依赖前置历史片段，不能安全导入或改写。请在源设备使用新版工具重新导出完整会话；不要只删除 history_base 字段。".into());
    }
    if let Some(session_id) = meta["payload"]["session_id"].as_str() {
        if Some(session_id) != meta["payload"]["id"].as_str() {
            return Err("会话 id 与 session_id 不一致，请在源设备重新导出。".into());
        }
    }
    visit(path, None, |v| {
        if v["type"] == "session_meta" && !v["payload"]["history_base"].is_null() {
            return Err("会话中含有未展开的历史依赖，请在源设备重新导出。".into());
        }
        Ok(())
    })
}

// A bounded byte prefix must end on a record boundary. Never silently truncate a
// malformed line (which could remove a user message or a tool result).
fn visit(
    path: &Path,
    limit: Option<u64>,
    mut f: impl FnMut(Value) -> Result<(), String>,
) -> Result<(), String> {
    let file = File::open(path).map_err(|e| format!("读取 {}：{e}", path.display()))?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let length = limit.unwrap_or(size);
    if length > size || length > MAX_BYTES {
        return Err(format!("历史截断位置超出文件长度：{}", path.display()));
    }
    let mut reader = BufReader::new(file.take(length));
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            break;
        }
        if limit.is_some() && !line.ends_with('\n') {
            return Err("历史字节偏移不在完整 JSONL 行边界上".into());
        }
        if line.trim().is_empty() {
            continue;
        }
        let value = serde_json::from_str(&line).map_err(|e| format!("历史 JSONL 损坏：{e}"))?;
        f(value)?;
    }
    Ok(())
}

#[derive(Clone)]
struct Segment {
    path: PathBuf,
    length: u64,
}

fn resolve(
    path: &Path,
    length: u64,
    candidates: &[(PathBuf, Value)],
    stack: &mut Vec<PathBuf>,
    segments: &mut Vec<Segment>,
) -> Result<(), String> {
    if stack.len() >= MAX_DEPTH || stack.iter().any(|p| p == path) {
        return Err("历史依赖存在循环或层数过多".into());
    }
    stack.push(path.to_path_buf());
    let meta = metadata(path)?;
    if let Some(base) = meta["payload"]["history_base"].as_object() {
        let id = base
            .get("thread_id")
            .and_then(Value::as_str)
            .ok_or("history_base 缺少 thread_id")?;
        let end = base
            .get("end_ordinal_exclusive")
            .and_then(Value::as_u64)
            .ok_or("history_base 缺少序号")?;
        let offset = base
            .get("end_byte_offset")
            .and_then(Value::as_u64)
            .ok_or("history_base 缺少字节偏移")?;
        let mut matched: Option<(PathBuf, Vec<u8>)> = None;
        for (candidate, cm) in candidates {
            if cm["payload"]["id"].as_str() != Some(id)
                || stack.contains(candidate)
                || cm["ordinal"].as_u64().unwrap_or(0) >= end
            {
                continue;
            }
            let mut last = None;
            if visit(candidate, Some(offset), |v| {
                last = v["ordinal"].as_u64();
                Ok(())
            })
            .is_err()
                || last.and_then(|n| n.checked_add(1)) != Some(end)
            {
                continue;
            }
            let mut file = File::open(candidate)
                .map_err(|e| e.to_string())?
                .take(offset);
            let mut hash = Sha256::new();
            let mut buf = [0; 65536];
            loop {
                let n = file.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                hash.update(&buf[..n]);
            }
            let digest = hash.finalize().to_vec();
            if let Some((_, previous)) = &matched {
                if previous != &digest {
                    return Err(format!(
                        "来源会话 {id} 存在多个不同的历史片段，无法安全确定版本"
                    ));
                }
            } else {
                matched = Some((candidate.clone(), digest));
            }
        }
        let (parent, _) = matched.ok_or_else(|| format!("缺少或损坏的来源历史片段：{id}，序号截止 {end}，字节截止 {offset}。请从原设备补齐前置 rollout 后重新导出。"))?;
        resolve(&parent, offset, candidates, stack, segments)?;
    } else if meta["ordinal"].as_u64().unwrap_or(0) != 0 {
        return Err("历史片段没有从序号 0 开始，也没有有效的 history_base".into());
    }
    segments.push(Segment {
        path: path.to_path_buf(),
        length,
    });
    stack.pop();
    Ok(())
}

pub fn export_standalone(home: &Path, src: &Path, dst: &Path) -> Result<(), String> {
    let mut meta = metadata(src)?;
    if meta["payload"]["history_base"].is_null() {
        validate_standalone(src)?;
        fs::copy(src, dst).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let mut candidates = Vec::new();
    for root in [home.join("sessions"), home.join("archived_sessions")] {
        for entry in walkdir::WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .flatten()
        {
            if entry.file_type().is_file()
                && entry.path().extension().and_then(|s| s.to_str()) == Some("jsonl")
            {
                if let Ok(m) = metadata(entry.path()) {
                    candidates.push((entry.path().to_path_buf(), m));
                }
            }
        }
    }
    let mut segments = Vec::new();
    resolve(
        src,
        fs::metadata(src).map_err(|e| e.to_string())?.len(),
        &candidates,
        &mut Vec::new(),
        &mut segments,
    )?;
    let total: u64 = segments.iter().map(|s| s.length).sum();
    if total > MAX_BYTES {
        return Err("完整会话历史超过 2 GiB，无法导出".into());
    }
    let payload = meta["payload"]
        .as_object_mut()
        .ok_or("session_meta payload 无效")?;
    payload.remove("history_base");
    payload.remove("forked_from_ordinal_exclusive");
    // Preserve forked_from_id as provenance only. No history depends on it now.
    if payload.contains_key("session_id") {
        payload.insert("session_id".into(), payload["id"].clone());
    }
    meta["ordinal"] = 0.into();
    let tmp = dst.with_extension("materializing");
    let result = (|| {
        let mut writer = BufWriter::new(File::create(&tmp).map_err(|e| e.to_string())?);
        writeln!(writer, "{meta}").map_err(|e| e.to_string())?;
        let mut ordinal = 1u64;
        for segment in segments {
            visit(&segment.path, Some(segment.length), |mut v| {
                if v["type"] == "session_meta" {
                    return Ok(());
                }
                v["ordinal"] = ordinal.into();
                ordinal += 1;
                writeln!(writer, "{v}").map_err(|e| e.to_string())
            })?;
        }
        writer.flush().map_err(|e| e.to_string())?;
        drop(writer);
        validate_standalone(&tmp)?;
        fs::rename(&tmp, dst).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("codex-history-{}", uuid::Uuid::now_v7()));
            fs::create_dir_all(p.join("sessions")).unwrap();
            fs::create_dir_all(p.join("archived_sessions")).unwrap();
            Self(p)
        }
        fn write(&self, name: &str, records: Vec<Value>) -> PathBuf {
            let p = self.0.join(name);
            fs::write(
                &p,
                records.iter().map(|v| format!("{v}\n")).collect::<String>(),
            )
            .unwrap();
            p
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn meta(id: &str, ordinal: u64, base: Value) -> Value {
        json!({"type":"session_meta","ordinal":ordinal,"payload":{
            "id":id,"session_id":id,"cwd":"D:\\old\\课程","history_mode":"paginated","history_base":base}})
    }
    fn event(n: u64, text: &str) -> Value {
        json!({"type":"response_item","ordinal":n,"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}})
    }
    fn base(id: &str, end: u64, path: &Path) -> Value {
        json!({"thread_id":id,"end_ordinal_exclusive":end,"end_byte_offset":fs::metadata(path).unwrap().len()})
    }
    fn records(p: &Path) -> Vec<Value> {
        fs::read_to_string(p)
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
    #[test]
    fn archived_parent_and_same_id_continuation_become_independent() {
        let f = Fixture::new();
        let parent = f.write(
            "archived_sessions/parent.jsonl",
            vec![meta("parent", 0, Value::Null), event(1, "ancestor")],
        );
        let first = f.write(
            "sessions/first.jsonl",
            vec![
                meta("child", 2, base("parent", 2, &parent)),
                event(3, "before continuation"),
            ],
        );
        let last = f.write(
            "sessions/last.jsonl",
            vec![
                meta("child", 4, base("child", 4, &first)),
                event(5, "after continuation"),
            ],
        );
        let out = f.0.join("out.jsonl");
        export_standalone(&f.0, &last, &out).unwrap();
        let v = records(&out);
        assert_eq!(v.len(), 4);
        assert_eq!(v[0]["payload"]["id"], "child");
        assert!(v[0]["payload"].get("history_base").is_none());
        for (i, r) in v.iter().enumerate() {
            assert_eq!(r["ordinal"], i as u64);
        }
        assert_eq!(v[1]["payload"], event(1, "ancestor")["payload"]);
        assert_eq!(v[3]["payload"], event(5, "after continuation")["payload"]);
        fs::remove_file(parent).unwrap();
        fs::remove_file(first).unwrap();
        fs::remove_file(last).unwrap();
        validate_standalone(&out).unwrap();
    }
    #[test]
    fn cutoff_excludes_later_parent_messages_and_preserves_unicode() {
        let f = Fixture::new();
        let parent = f.write(
            "sessions/parent.jsonl",
            vec![meta("p", 0, Value::Null), event(1, "共享中文")],
        );
        let cutoff = base("p", 2, &parent);
        use std::fs::OpenOptions;
        writeln!(
            OpenOptions::new().append(true).open(&parent).unwrap(),
            "{}",
            event(2, "must not leak")
        )
        .unwrap();
        let child = f.write(
            "sessions/child.jsonl",
            vec![meta("c", 2, cutoff), event(3, "own text")],
        );
        let out = f.0.join("out.jsonl");
        export_standalone(&f.0, &child, &out).unwrap();
        let text = fs::read_to_string(out).unwrap();
        assert!(text.contains("共享中文"));
        assert!(!text.contains("must not leak"));
    }
    #[test]
    fn missing_or_mutated_parent_is_rejected_without_output() {
        let f = Fixture::new();
        let parent = f.write(
            "sessions/p.jsonl",
            vec![meta("p", 0, Value::Null), event(1, "long original")],
        );
        let child = f.write(
            "sessions/c.jsonl",
            vec![meta("c", 2, base("p", 2, &parent)), event(3, "child")],
        );
        let out = f.0.join("out.jsonl");
        fs::write(
            &parent,
            format!("{}\n{}\n", meta("p", 0, Value::Null), event(1, "short")),
        )
        .unwrap();
        assert!(export_standalone(&f.0, &child, &out)
            .unwrap_err()
            .contains("缺少或损坏"));
        assert!(!out.exists());
        fs::remove_file(parent).unwrap();
        assert!(export_standalone(&f.0, &child, &out).is_err());
        assert!(validate_standalone(&child).is_err());
    }
    #[test]
    fn cutoff_inside_json_line_is_rejected() {
        let f = Fixture::new();
        let p = f.write(
            "sessions/p.jsonl",
            vec![meta("p", 0, Value::Null), event(1, "parent")],
        );
        let mut b = base("p", 2, &p);
        b["end_byte_offset"] = (fs::metadata(&p).unwrap().len() - 2).into();
        let c = f.write("sessions/c.jsonl", vec![meta("c", 2, b)]);
        assert!(export_standalone(&f.0, &c, &f.0.join("out")).is_err());
    }
    #[test]
    fn differing_parent_copies_are_ambiguous() {
        let f = Fixture::new();
        let p = f.write(
            "sessions/p.jsonl",
            vec![meta("p", 0, Value::Null), event(1, "aaaa")],
        );
        f.write(
            "archived_sessions/p.jsonl",
            vec![meta("p", 0, Value::Null), event(1, "bbbb")],
        );
        let c = f.write("sessions/c.jsonl", vec![meta("c", 2, base("p", 2, &p))]);
        assert!(export_standalone(&f.0, &c, &f.0.join("out"))
            .unwrap_err()
            .contains("多个不同"));
    }
    #[test]
    fn rejects_identity_mismatch_and_invalid_later_json() {
        let f = Fixture::new();
        let mut m = meta("a", 0, Value::Null);
        m["payload"]["session_id"] = "b".into();
        let p = f.write("sessions/p.jsonl", vec![m]);
        assert!(validate_standalone(&p).is_err());
        fs::write(&p, format!("{}\n{{truncated", meta("a", 0, Value::Null))).unwrap();
        assert!(validate_standalone(&p).is_err());
    }
    #[test]
    fn standalone_export_preserves_original_bytes() {
        let f = Fixture::new();
        let p = f.write(
            "sessions/p.jsonl",
            vec![meta("p", 0, Value::Null), event(1, "old")],
        );
        let out = f.0.join("out");
        export_standalone(&f.0, &p, &out).unwrap();
        assert_eq!(fs::read(p).unwrap(), fs::read(out).unwrap());
    }
}
