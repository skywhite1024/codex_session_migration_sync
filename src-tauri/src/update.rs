use serde::{Deserialize, Serialize};

use crate::errors::{AppError, AppResult};

// Where releases are published.
const UPSTREAM_REPO: &str = "skywhite1024/codex_session_migration_sync";

#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub release_url: String,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubLatestRelease {
    tag_name: String,
    html_url: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
}

pub fn check_update(current_version: &str) -> AppResult<UpdateCheckResult> {
    let url = format!("https://api.github.com/repos/{UPSTREAM_REPO}/releases/latest");

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout_read(std::time::Duration::from_secs(20))
        .timeout_write(std::time::Duration::from_secs(20))
        .build();

    let resp = agent
        .get(&url)
        .set("User-Agent", "CodexRelay")
        .call()
        .map_err(|e| AppError::io(format!("检查更新失败：{e}")))?;

    let body = resp
        .into_string()
        .map_err(|e| AppError::io(format!("读取更新信息失败：{e}")))?;
    let rel: GitHubLatestRelease = serde_json::from_str(&body)
        .map_err(|e| AppError::internal(format!("parse release: {e}")))?;

    if rel.draft {
        return Err(AppError::internal(
            "GitHub latest release 是 draft（不应发生）",
        ));
    }
    if rel.prerelease {
        // `latest` normally excludes prerelease; keep guardrail anyway.
        return Err(AppError::internal(
            "GitHub latest release 是 prerelease（不应发生）",
        ));
    }

    let latest_version = rel.tag_name.trim_start_matches('v').to_string();
    let has_update = match (
        parse_simple_semver(&latest_version),
        parse_simple_semver(current_version),
    ) {
        (Some(latest), Some(current)) => latest > current,
        _ => latest_version != current_version,
    };

    Ok(UpdateCheckResult {
        current_version: current_version.to_string(),
        latest_version,
        has_update,
        release_url: rel.html_url,
        published_at: rel.published_at,
    })
}

fn parse_simple_semver(v: &str) -> Option<(u64, u64, u64)> {
    let s = v.trim().trim_start_matches('v');
    let mut it = s.split('.');
    let a = it.next()?.parse().ok()?;
    let b = it.next()?.parse().ok()?;
    let c = it.next()?.parse().ok()?;
    Some((a, b, c))
}
