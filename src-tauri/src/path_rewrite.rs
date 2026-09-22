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
//! - 先解析 JSON，再改写字符串值，由 serde_json 负责完整转义；
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
        // 注意：不能用当前平台的 `Path::is_absolute()`。本工具的核心场景就是跨 OS
        // 迁移——在 Windows 上导入 macOS/Linux 导出的会话时，「旧路径」形如
        // `/Users/alex/proj`，对 Windows 的 `Path` 而言并不算绝对路径，但它确实是
        // A 机上的绝对路径。因此这里同时接受 POSIX 与 Windows 两种绝对路径写法。
        if !is_absolute_any_platform(from) {
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

/// 平台无关的绝对路径判断，同时接受 POSIX 与 Windows 两种写法。
///
/// - Windows 盘符路径：`C:\...`、`C:/...`
/// - Windows UNC 路径：`\\server\share`、`//server/share`
/// - POSIX 路径：`/Users/...`
fn is_absolute_any_platform(p: &str) -> bool {
    let bytes = p.as_bytes();
    // 盘符：X:\ 或 X:/
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    // UNC 或 POSIX 绝对路径。
    p.starts_with('/') || p.starts_with('\\')
}

/// Windows 源路径用于匹配时统一分隔符和 ASCII 大小写，输出保留目标路径拼写。
struct CompiledRewrite {
    from: String,
    to: String,
    windows_source: bool,
    separator: char,
}

fn is_windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || path.starts_with("\\\\")
        || path.starts_with("//")
}

impl CompiledRewrite {
    fn compile(rw: &PathRewrite) -> Result<Self, String> {
        rw.validate()?;
        let windows_source = is_windows_path(&rw.from);
        let mut from = rw.from.clone();
        if windows_source {
            from = from.replace('\\', "/");
            from.make_ascii_lowercase();
        }
        if from != "/" {
            from = from.trim_end_matches('/').to_string();
        }
        if from.is_empty() {
            return Err("路径映射的旧路径不能仅包含重复分隔符".to_string());
        }
        Ok(Self {
            from,
            to: rw.to.clone(),
            windows_source,
            separator: if is_windows_path(&rw.to) && rw.to.contains('\\') {
                '\\'
            } else {
                '/'
            },
        })
    }

    fn replace_path(&self, tail: &str) -> String {
        let tail = if self.windows_source {
            tail.replace('\\', "/")
        } else {
            tail.to_string()
        };
        let tail = if self.separator == '\\' {
            tail.replace('/', "\\")
        } else {
            tail
        };
        if tail.is_empty() {
            return self.to.clone();
        }
        let target = self.to.trim_end_matches(self.separator);
        if self.from.ends_with('/') && !tail.starts_with(self.separator) {
            format!("{target}{}{tail}", self.separator)
        } else {
            format!("{target}{tail}")
        }
    }
}

/// 命中边界是否合法：前缀后面必须是路径分隔符、JSON 引号、空白、行尾或扩展名点。
/// 这样 `C:\proj` 不会命中 `C:\proj-other`。
fn boundary_ok(rest: &str) -> bool {
    let Some(next) = rest.chars().next() else {
        return true; // 行尾
    };
    next.is_whitespace() || matches!(next, '/' | '\\' | '"' | '\'' | '.' | ')' | ']' | ',' | ';')
}

/// 正文只转换命中的路径片段，不能把命令或其他路径中的反斜杠一起改掉。
fn rewrite_text(text: &str, rules: &[CompiledRewrite], path_field: bool) -> String {
    if rules.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + 64);
    let mut rest = text;
    loop {
        let mut best: Option<(usize, &CompiledRewrite)> = None;
        for r in rules {
            let mut searchable = rest.to_string();
            if r.windows_source {
                searchable = searchable.replace('\\', "/");
                searchable.make_ascii_lowercase();
            }
            for (idx, _) in searchable.match_indices(&r.from) {
                let before_ok = idx == 0
                    || rest[..idx].ends_with(|c: char| {
                        c.is_whitespace() || matches!(c, '"' | '\'' | '(' | '[' | '{' | '=' | ':')
                    });
                if !before_ok
                    || (!r.from.ends_with('/') && !boundary_ok(&rest[idx + r.from.len()..]))
                {
                    continue;
                }
                match best {
                    Some((bi, br)) if bi < idx || (bi == idx && br.from.len() >= r.from.len()) => {}
                    _ => best = Some((idx, r)),
                }
                break;
            }
        }
        let Some((idx, r)) = best else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..idx]);
        let tail = &rest[idx + r.from.len()..];
        let tail_len = if path_field && idx == 0 && out.is_empty() {
            tail.len()
        } else if let Some(quote @ ('"' | '\'')) = rest[..idx].chars().next_back() {
            tail.find(quote).unwrap_or(tail.len())
        } else {
            tail.find(|c: char| {
                c.is_whitespace()
                    || matches!(
                        c,
                        '"' | '\'' | ')' | ']' | '}' | ',' | ';' | '&' | '|' | '<' | '>' | '`'
                    )
            })
            .unwrap_or(tail.len())
        };
        out.push_str(&r.replace_path(&tail[..tail_len]));
        rest = &tail[tail_len..];
    }
}

fn rewrite_value(value: &mut serde_json::Value, rules: &[CompiledRewrite], path_field: bool) {
    match value {
        serde_json::Value::String(text) => *text = rewrite_text(text, rules, path_field),
        serde_json::Value::Array(items) => {
            for item in items {
                rewrite_value(item, rules, false);
            }
        }
        serde_json::Value::Object(fields) => {
            for (key, value) in fields {
                // 明确的路径字段允许空格、引号等合法文件名字符。
                rewrite_value(
                    value,
                    rules,
                    matches!(key.as_str(), "cwd" | "path" | "workdir" | "file_path"),
                );
            }
        }
        _ => {}
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

        let mut v: serde_json::Value =
            serde_json::from_str(&line).map_err(|e| format!("parse rollout json line: {e}"))?;
        rewrite_value(&mut v, &rules, false);
        if let Some(new_id) = new_session_id {
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
        }
        let final_text =
            serde_json::to_string(&v).map_err(|e| format!("serialize rollout: {e}"))?;

        writeln!(writer, "{final_text}").map_err(|e| format!("write rollout: {e}"))?;
    }

    writer
        .flush()
        .map_err(|e| format!("flush rewritten rollout: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply_line(line: &str, rules: &[CompiledRewrite]) -> String {
        let mut value = serde_json::from_str(line).unwrap();
        rewrite_value(&mut value, rules, false);
        serde_json::to_string(&value).unwrap()
    }

    fn rewrite_fixture(value: serde_json::Value, from: &str, to: &str) -> serde_json::Value {
        let dir = std::env::temp_dir().join(format!("codexrelay-rebind-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.jsonl");
        let dst = dir.join("out.jsonl");
        fs::write(&src, format!("{}\n", value)).unwrap();
        rewrite_rollout(
            &src,
            &dst,
            None,
            "old",
            &[PathRewrite {
                from: from.into(),
                to: to.into(),
            }],
        )
        .unwrap();
        let result = serde_json::from_str(&fs::read_to_string(&dst).unwrap()).unwrap();
        fs::remove_dir_all(dir).unwrap();
        result
    }

    #[test]
    fn windows_to_posix_rewrites_child_paths_but_not_unrelated_backslashes() {
        let result = rewrite_fixture(
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "cwd": "C:\\work\\proj\\folder name\\subdir",
                    "text": "cat C:\\work\\proj\\src\\main.rs && echo \\keep\\this",
                    "paths": ["C:\\work\\proj\\src\\main.rs"]
                }
            }),
            "C:\\work\\proj",
            "/home/dex/proj",
        );
        assert_eq!(
            result["payload"]["cwd"],
            "/home/dex/proj/folder name/subdir"
        );
        assert_eq!(
            result["payload"]["text"],
            "cat /home/dex/proj/src/main.rs && echo \\keep\\this"
        );
        assert_eq!(result["payload"]["paths"][0], "/home/dex/proj/src/main.rs");
    }

    #[test]
    fn special_characters_in_posix_target_remain_valid_json() {
        let target = "/home/dex/a\"b\\literal\tname";
        let result = rewrite_fixture(
            serde_json::json!({"cwd": "C:\\work\\proj\\child", "text": "open C:\\work\\proj"}),
            "C:\\work\\proj",
            target,
        );
        assert_eq!(result["cwd"], format!("{target}/child"));
        assert_eq!(result["text"], format!("open {target}"));
    }

    #[test]
    fn posix_to_windows_rewrites_child_separators() {
        let result = rewrite_fixture(
            serde_json::json!({"cwd": "/home/alex/proj/sub/dir"}),
            "/home/alex/proj",
            "D:\\work\\proj",
        );
        assert_eq!(result["cwd"], "D:\\work\\proj\\sub\\dir");
    }

    #[test]
    fn quoted_history_paths_keep_spaces_and_unrelated_escapes() {
        let result = rewrite_fixture(
            serde_json::json!({"text": "cat \"C:\\work\\proj\\folder name\\a.txt\" && echo \\keep"}),
            r"C:\work\proj",
            "/srv/proj",
        );
        assert_eq!(
            result["text"],
            "cat \"/srv/proj/folder name/a.txt\" && echo \\keep"
        );
    }

    #[test]
    fn matching_handles_case_separators_boundaries_and_overlapping_rules() {
        let rules = [
            PathRewrite {
                from: r"C:\work\proj\".into(),
                to: "/srv/proj".into(),
            },
            PathRewrite {
                from: r"C:\work\proj\special".into(),
                to: "/srv/special".into(),
            },
        ]
        .iter()
        .map(|r| CompiledRewrite::compile(r).unwrap())
        .collect::<Vec<_>>();
        assert_eq!(
            rewrite_text(r"c:/WORK/PROJ-other C:/Work/Proj/src", &rules, false),
            "c:/WORK/PROJ-other /srv/proj/src"
        );
        assert_eq!(
            rewrite_text(r"C:\work\proj\special\child", &rules, true),
            "/srv/special/child"
        );
        let result = rewrite_fixture(
            serde_json::json!({"cwd":"/Users/Proj/child"}),
            "/Users/proj",
            "/srv/proj",
        );
        assert_eq!(result["cwd"], "/Users/Proj/child");
    }

    #[test]
    fn posix_root_and_literal_backslashes_are_preserved() {
        let result = rewrite_fixture(
            serde_json::json!({"cwd": "/old/a\\b/child"}),
            "/old",
            "/new",
        );
        assert_eq!(result["cwd"], r"/new/a\b/child");
        let result = rewrite_fixture(serde_json::json!({"cwd": "/home/dex"}), "/", "/mnt");
        assert_eq!(result["cwd"], "/mnt/home/dex");
        let result = rewrite_fixture(serde_json::json!({"cwd": "/old/child"}), "/old", "/");
        assert_eq!(result["cwd"], "/child");
        assert!(CompiledRewrite::compile(&PathRewrite {
            from: "//".into(),
            to: "/mnt".into(),
        })
        .is_err());
    }

    #[test]
    fn invalid_json_is_rejected_even_without_an_id_change() {
        let dir = std::env::temp_dir().join(format!("codexrelay-invalid-{}", uuid::Uuid::now_v7()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.jsonl");
        let dst = dir.join("out.jsonl");
        fs::write(&src, "{\"cwd\":\"/old\"}\nnot json\n").unwrap();
        let err = rewrite_rollout(
            &src,
            &dst,
            None,
            "old",
            &[PathRewrite {
                from: "/old".into(),
                to: "/new".into(),
            }],
        )
        .unwrap_err();
        assert!(err.contains("parse rollout json line"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_empty_and_relative_from() {
        assert!(PathRewrite {
            from: "  ".into(),
            to: "D:\\a".into()
        }
        .validate()
        .is_err());
        assert!(PathRewrite {
            from: "relative/path".into(),
            to: "D:\\a".into()
        }
        .validate()
        .is_err());
        assert!(PathRewrite {
            from: "D:\\a".into(),
            to: "".into()
        }
        .validate()
        .is_err());
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
        let line =
            r#"{"payload":{"cwd":"/Users/alex/proj"},"cmd":"cd /Users/alex/proj/src && ls"}"#;
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
            &[PathRewrite {
                from: "/Users/alex/proj".into(),
                to: "/srv/proj".into(),
            }],
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
