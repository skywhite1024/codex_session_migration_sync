//! Register imported rollouts with Codex app-server.
//!
//! `session_index.jsonl` is enough for older CLI pickers, but Codex Desktop keeps
//! an additional thread catalog. A metadata-only `thread/resume` makes an imported
//! rollout known to that catalog without starting a turn or changing the conversation.

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    time::Duration,
};

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);
const RESUME_TIMEOUT: Duration = Duration::from_secs(30);

fn codex_program() -> String {
    if let Ok(path) = std::env::var("CODEX_CLI_PATH") {
        if !path.trim().is_empty() && Path::new(&path).is_file() {
            return path;
        }
    }
    if cfg!(windows) {
        "codex.exe".to_string()
    } else {
        "codex".to_string()
    }
}

fn send(stdin: &mut ChildStdin, value: Value) -> Result<(), String> {
    serde_json::to_writer(&mut *stdin, &value)
        .map_err(|e| format!("serialize app-server request: {e}"))?;
    stdin
        .write_all(b"\n")
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("write app-server request: {e}"))
}

fn response_for_id(line: &str, expected_id: u64) -> Option<Result<(), String>> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("id").and_then(Value::as_u64) != Some(expected_id) {
        return None;
    }
    if value.get("result").is_some() {
        return Some(Ok(()));
    }
    let message = value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("app-server returned an unknown error");
    Some(Err(message.to_string()))
}

fn wait_for_response(
    receiver: &Receiver<String>,
    request_id: u64,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(format!("等待 app-server 响应超时（request {request_id}）"));
        }
        let line = receiver
            .recv_timeout(remaining)
            .map_err(|e| format!("读取 app-server 响应失败：{e}"))?;
        if let Some(response) = response_for_id(&line, request_id) {
            return response;
        }
    }
}

fn stop_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

pub fn register_threads(
    codex_home: &Path,
    thread_ids: &[String],
    titles: &HashMap<String, String>,
) -> HashMap<String, Result<(), String>> {
    let mut results = HashMap::new();
    if thread_ids.is_empty() {
        return results;
    }

    let mut child = match Command::new(codex_program())
        .args(["app-server", "--stdio"])
        .env("CODEX_HOME", codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let message = format!("无法启动 Codex app-server：{error}");
            for id in thread_ids {
                results.insert(id.clone(), Err(message.clone()));
            }
            return results;
        }
    };

    let Some(mut stdin) = child.stdin.take() else {
        stop_child(&mut child);
        return thread_ids
            .iter()
            .map(|id| (id.clone(), Err("无法连接 app-server stdin".to_string())))
            .collect();
    };
    let Some(stdout) = child.stdout.take() else {
        stop_child(&mut child);
        return thread_ids
            .iter()
            .map(|id| (id.clone(), Err("无法连接 app-server stdout".to_string())))
            .collect();
    };

    let (sender, receiver) = mpsc::channel();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if sender.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let init_result = send(
        &mut stdin,
        json!({
            "method": "initialize",
            "id": 1,
            "params": {
                "clientInfo": {
                    "name": "codex-session-migration-sync",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
    )
    .and_then(|_| wait_for_response(&receiver, 1, INITIALIZE_TIMEOUT))
    .and_then(|_| send(&mut stdin, json!({ "method": "initialized" })));

    if let Err(error) = init_result {
        for id in thread_ids {
            results.insert(id.clone(), Err(error.clone()));
        }
    } else {
        for (index, id) in thread_ids.iter().enumerate() {
            let title = titles.get(id).map(String::as_str).unwrap_or("");
            let request_id = index as u64 + 2;
            let result = send(
                &mut stdin,
                json!({
                    "method": "thread/resume",
                    "id": request_id,
                    "params": {
                        "threadId": id,
                        "excludeTurns": true
                    }
                }),
            )
            .and_then(|_| wait_for_response(&receiver, request_id, RESUME_TIMEOUT))
            .and_then(|_| {
                let name_request_id = request_id + thread_ids.len() as u64;
                send(
                    &mut stdin,
                    json!({
                        "method": "thread/name/set",
                        "id": name_request_id,
                        "params": { "threadId": id, "name": title }
                    }),
                )
                .and_then(|_| {
                    wait_for_response(&receiver, name_request_id, Duration::from_secs(15))
                })
            });
            results.insert(id.clone(), result);
        }
    }

    drop(stdin);
    stop_child(&mut child);
    let _ = reader.join();
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_the_expected_response() {
        assert!(response_for_id(r#"{"id":1,"result":{}}"#, 2).is_none());
        assert_eq!(response_for_id(r#"{"id":2,"result":{}}"#, 2), Some(Ok(())));
        assert_eq!(
            response_for_id(r#"{"id":2,"error":{"message":"missing"}}"#, 2),
            Some(Err("missing".to_string()))
        );
    }
}
