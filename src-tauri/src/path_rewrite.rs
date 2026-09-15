//! 跨设备导入时的"路径重绑"（cwd rebind）。
//!
//! Codex rollout 第一行的 `session_meta.payload.cwd` 固化了 A 机上的项目绝对路径。
//! 两台机器路径不一致时，直接 resume 会让 agent 对着 B 机上不存在的目录工作。
//! 本模块在导入时把 rollout 中出现的旧路径前缀替换为新路径，同时保持 JSONL
//! 每行仍是合法 JSON。
//!
//! 设计要点：
//! - 只做"前缀替换"，不碰路径中间的相对片段；
//! - 带边界保护：`C:\proj` 不会误伤 `C:\proj-other`（要求命中后紧跟 `/`、`\`、
//!   `"`、空格、行尾或扩展名点）；
//! - 同时处理 JSON 原始形式和 JSON 转义形式（Windows 反斜杠在 JSON 里是 `\\`）；
//! - 与"改 session id"合并在一次流式遍历里完成，避免两次读大文件。

use serde::Deserialize;
use std::{
    fs,
    io::{BufRead, BufReader, BufWriter, Write},
    path::Path,
};

/// 用户传入的一条路径映射。
#[derive(Debug, Clone, Deserialize)]
pub struct PathRewrite {
    /// A 机上的旧绝对路径前缀，例如 `/Users/alex/proj` 或 `C:\Users\alex\proj`。
    pub from: String,
    /// B 机上的新绝对路径前缀，例如 `D:\work\proj`。
    pub to: String,
}

impl PathRewrite {
    /// 基本合法性校验：拒绝空 from、相对 from，避免误伤。
    pub fn validate(&self) -> Result<(), String> {
        let from = self.from.trim();
        if from.is_empty() {
            return Err("路径映射的「旧路径」不能为空".to_string());
        }
        if !Path::new(from).is_absolute() {
            return Err(format!(
                "路径映射的「旧路径」必须是绝对路径（当前：{from:?}）"
            ));
        }
        if self.to.trim().is_empty() {
            return Err("路径映射的「新路径」不能为空".to_string());
        }
        Ok(())
    }
}

/// 预编译后的映射，同时保留原始形式与 JSON 转义形式。
struct CompiledRewrite {
    /// 原始形式（用户输入原样）。
    from_raw: String,
    /// JSON 文本形式：`\` 写成 `\\`。
    from_json: String,
    to_raw: String,
    to_json: String,
}

fn escape_json_path(p: &str) -> String {
    p.replace('\\', "\\\\")
}

impl CompiledRewrite {
    fn compile(rw: &PathRewrite) -> Result<Self, String> {
        rw.validate()?;
        Ok(Self {
            from_raw: rw.from.trim_end_matches(&['/', '\\']).to_string(),
            from_json: escape_json_path(rw.from.trim_end_matches(&['/', '\\'])),
            to_raw: rw.to.clone(),
            to_json: escape_json_path(&rw.to),
        })
    }
}

/// 命中边界是否合法：前缀后面必须是路径分隔符、JSON 引号、空白、行尾或扩展名点。
/// 这样 `C:\proj` 不会命中 `C:\proj-other`。
fn boundary_ok(rest: &str) -> bool {
    let Some(next) = rest.chars().next() else {
        return true; // 行尾
    };
    matches!(next, '/' | '\\' | '"' | ' ' | '\t' | '\r' | '.' | ')')
}

/// 在单行文本上应用所有映射。`line` 是整行 JSON 文本。
pub fn apply_line(line: &str, rules: &[CompiledRewrite]) -> String {
    if rules.is_empty() {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len() + 64);
    let mut rest = line;
    loop {
        // 找所有规则在 rest 中的最早命中位置。
        let mut best: Option<(usize, &CompiledRewrite, bool)> = None;
        for r in rules {
            for (idx, is_json) in rest
                .find(&r.from_json)
                .map(|i| (i, true))
                .into_iter()
                .chain(rest.find(&r.from_raw).map(|i| (i, false)))
            {
                // 边界检查：命中片段之后必须是合法边界。
                let after = &rest[idx + (if is_json {
                    r.from_json.len()
                } else {
                    r.from_raw.len()
                })..];
                if !boundary_ok(after) {
                    continue;
                }
                match best {
                    Some((bi, _, _)) if bi <= idx => {}
                    _ => best = Some((idx, r, is_json)),
                }
            }
        }
        let Some((idx, r, is_json)) = best else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..idx]);
        let consumed = if is_json { r.from_json.len() } else { r.from_raw.len() };
        out.push_str(if is_json { &r.to_json } else { &r.to_raw });
        rest = &rest[idx + consumed..];
    }
}

/// 导入时对 rollout 做一次流式改写。
///
/// - `new_session_id`：若为 `Some`，同时把 `session_meta.payload.id` 改掉（对应
///   "导入为新会话"分叉场景）；
/// - `path_rewrites`：路径前缀映射；
/// - 两者都为空时直接拷贝字节，不做无谓的 JSON 重序列化。
pub fn rewrite_rollout(
    src: &Path,
    dst: &Path,
    new_session_id: Option<&str>,
    old_session_id: &str,
    path_rewrites: &[PathRewrite],
) -> Result<(), String> {
    let rules: Vec<CompiledRewrite> = path_rewrites
        .iter()
        .map(CompiledRewrite::compile)
        .collect::<Result<_, _>>()?;

    // 没有任何改写需求时退化为直接拷贝。
    if new_session_id.is_none() && rules.is_empty() {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
        }
        fs::copy(src, dst).map_err(|e| format!("copy rollout: {e}"))?;
        return Ok(());
    }

    let input = fs::File::open(src).map_err(|e| format!("open rollout: {e}"))?;
    let reader = BufReader::new(input);
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let output = fs::File::create(dst).map_err(|e| format!("create rewritten rollout: {e}"))?;
    let mut writer = BufWriter::new(output);

    for line in reader.lines() {
        let line = line.map_err(|e| format!("read rollout line: {e}"))?;
        if line.trim().is_empty() {
            writeln!(writer).map_err(|e| format!("write rollout: {e}"))?;
            continue;
        }

        // 路径重写是纯文本级操作，不需要先 parse JSON；但改 session id 需要结构化。
        let rewritten_text = apply_line(&line, &rules);

        let final_text = if let Some(new_id) = new_session_id {
            let mut v: serde_json::Value = serde_json::from_str(&rewritten_text)
                .map_err(|e| format!("parse rollout json line: {e}"))?;
            let is_meta = v
                .get("type")
                .and_then(|x| x.as_str())
                .map(|t| t == "session_meta")
                .unwrap_or(false);
            let id_match = v
                .pointer("/payload/id")
                .and_then(|x| x.as_str())
                .map(|id| id == old_session_id)
                .unwrap_or(false);
            if is_meta && id_match {
                if let Some(p) = v.pointer_mut("/payload/id") {
                    *p = serde_json::Value::String(new_id.to_string());
                }
            }
            serde_json::to_string(&v).map_err(|e| format!("serialize rollout: {e}"))?
        } else {
            rewritten_text
        };

        writeln!(writer, "{final_text}").map_err(|e| format!("write rollout: {e}"))?;
    }

    writer.flush().map_err(|e| format!("flush rewritten rollout: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_and_relative_from() {
        assert!(PathRewrite { from: "  ".into(), to: "D:\\a".into() }.validate().is_err());
        assert!(PathRewrite { from: "relative/path".into(), to: "D:\\a".into() }.validate().is_err());
        assert!(PathRewrite { from: "D:\\a".into(), to: "".into() }.validate().is_err());
    }

    #[test]
    fn rewrites_cwd_structurally_and_inline_windows_paths() {
        let line = r#"{"type":"session_meta","payload":{"id":"s1","cwd":"C:\\Users\\alex\\proj","cli_version":"0.1"}}
"#;
        let rw = PathRewrite {
            from: "C:\\Users\\alex\\proj".into(),
            to: "D:\\work\\proj".into(),
        };
        let out = apply_line(line, &[CompiledRewrite::compile(&rw).unwrap()]);
        assert!(out.contains(r#""cwd":"D:\\work\\proj""#), "got: {out}");
    }

    #[test]
    fn does_not_touch_unrelated_prefix_like_names() {
        // C:\proj-other 不应被 C:\proj 误伤。
        let line = r#"{"cwd":"C:\\proj-other\\src"}"#;
        let rw = PathRewrite {
            from: "C:\\proj".into(),
            to: "D:\\new".into(),
        };
        let out = apply_line(line, &[CompiledRewrite::compile(&rw).unwrap()]);
        assert!(out.contains("proj-other"), "got: {out}");
        assert!(!out.contains("D:\\\\new"), "got: {out}");
    }

    #[test]
    fn rewrites_posix_paths_and_keeps_tail() {
        let line = r#"{"payload":{"cwd":"/Users/alex/proj"},"cmd":"cd /Users/alex/proj/src && ls"}"#;
        let rw = PathRewrite {
            from: "/Users/alex/proj".into(),
            to: "/home/bob/work/proj".into(),
        };
        let out = apply_line(line, &[CompiledRewrite::compile(&rw).unwrap()]);
        assert_eq!(out.matches("/home/bob/work/proj").count(), 2);
        assert!(out.contains("/home/bob/work/proj/src"));
    }

    #[test]
    fn rewrite_rollout_end_to_end_changes_id_and_cwd() {
        let dir = std::env::temp_dir().join(format!("codexrelay-pr-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.jsonl");
        let dst = dir.join("out.jsonl");
        std::fs::write(
            &src,
            concat!(
                r#"{"type":"session_meta","payload":{"id":"old","cwd":"/Users/alex/proj","cli_version":"1.0"}}"#,
                "\n",
                r#"{"type":"event","payload":{"path":"/Users/alex/proj/a.rs"}}"#,
                "\n",
            ),
        )
        .unwrap();

        rewrite_rollout(
            &src,
            &dst,
            Some("new-id"),
            "old",
            &[PathRewrite { from: "/Users/alex/proj".into(), to: "/srv/proj".into() }],
        )
        .unwrap();

        let text = std::fs::read_to_string(&dst).unwrap();
        assert!(text.contains(r#""id":"new-id""#));
        assert!(text.contains(r#""cwd":"/srv/proj""#));
        assert!(text.contains(r#""/srv/proj/a.rs""#));
        assert!(!text.contains("/Users/alex"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
