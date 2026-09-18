//! Minimal, comment-preserving updates to Codex's local project trust config.
//!
//! Imported rollouts can be perfectly valid and indexed while still being hidden by
//! Codex Desktop when their working directory has never been trusted on this device.
//! This module only touches the exact `[projects.<cwd>].trust_level` entry requested
//! by the user and creates a backup before the first write.

use std::{fs, path::Path};
use toml_edit::{value, DocumentMut, Item, Table};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectTrustResult {
    pub trusted: bool,
    pub changed: bool,
}

fn normalized_project_key(cwd: &Path) -> String {
    let raw = cwd.to_string_lossy().to_string();
    let trimmed = raw.trim_end_matches(['\\', '/']);
    let raw = if trimmed.is_empty() || trimmed.ends_with(':') {
        raw
    } else {
        trimmed.to_string()
    };
    #[cfg(windows)]
    {
        raw.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        raw
    }
}

fn matching_project_key(projects: &Table, wanted: &str) -> Option<String> {
    projects.iter().find_map(|(key, _)| {
        #[cfg(windows)]
        let matches = key.eq_ignore_ascii_case(wanted);
        #[cfg(not(windows))]
        let matches = key == wanted;
        matches.then(|| key.to_string())
    })
}

pub fn ensure_project_trusted(codex_home: &Path, cwd: &Path) -> Result<ProjectTrustResult, String> {
    if !cwd.is_absolute() {
        return Err(format!("项目目录不是绝对路径：{}", cwd.display()));
    }
    if !cwd.is_dir() {
        return Err(format!("项目目录不存在或不是文件夹：{}", cwd.display()));
    }

    let config_path = codex_home.join("config.toml");
    let original = match fs::read_to_string(&config_path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("读取 {} 失败：{e}", config_path.display())),
    };
    let mut doc = original
        .parse::<DocumentMut>()
        .map_err(|e| format!("解析 {} 失败：{e}", config_path.display()))?;

    if !doc.contains_key("projects") {
        doc["projects"] = Item::Table(Table::new());
    }
    let projects = doc["projects"]
        .as_table_mut()
        .ok_or_else(|| "config.toml 中的 projects 不是表，无法安全更新".to_string())?;
    let wanted = normalized_project_key(cwd);
    let key = matching_project_key(projects, &wanted).unwrap_or(wanted);

    if !projects.contains_key(&key) {
        projects[&key] = Item::Table(Table::new());
    }
    let project = projects[&key]
        .as_table_mut()
        .ok_or_else(|| format!("config.toml 中项目 {key} 的配置不是表"))?;
    if project.get("trust_level").and_then(Item::as_str) == Some("trusted") {
        return Ok(ProjectTrustResult {
            trusted: true,
            changed: false,
        });
    }
    project["trust_level"] = value("trusted");

    fs::create_dir_all(codex_home).map_err(|e| format!("创建 CODEX_HOME 失败：{e}"))?;
    if config_path.exists() {
        let backup = codex_home.join("config.toml.codexrelay.bak");
        if !backup.exists() {
            fs::copy(&config_path, &backup).map_err(|e| format!("备份 config.toml 失败：{e}"))?;
        }
    }
    fs::write(&config_path, doc.to_string())
        .map_err(|e| format!("写入 {} 失败：{e}", config_path.display()))?;

    Ok(ProjectTrustResult {
        trusted: true,
        changed: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codexrelay-config-{label}-{}",
            uuid::Uuid::now_v7()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn adds_trust_and_preserves_existing_config() {
        let root = temp_dir("add");
        let home = root.join("codex");
        let project = root.join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&project).unwrap();
        fs::write(home.join("config.toml"), "model = \"gpt-test\"\n").unwrap();

        let result = ensure_project_trusted(&home, &project).unwrap();
        assert!(result.trusted);
        assert!(result.changed);
        let text = fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(text.contains("model = \"gpt-test\""));
        assert!(text.contains("trust_level = \"trusted\""));
        assert!(home.join("config.toml.codexrelay.bak").exists());
        let parsed = text.parse::<DocumentMut>().unwrap();
        let key = normalized_project_key(&project);
        assert_eq!(
            parsed["projects"][&key]["trust_level"].as_str(),
            Some("trusted")
        );

        let second = ensure_project_trusted(&home, &project).unwrap();
        assert!(second.trusted);
        assert!(!second.changed);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_missing_project_directory() {
        let root = temp_dir("missing");
        let err = ensure_project_trusted(&root, &root.join("absent")).unwrap_err();
        assert!(err.contains("不存在"));
        fs::remove_dir_all(root).unwrap();
    }
}
