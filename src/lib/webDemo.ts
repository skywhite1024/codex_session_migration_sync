import type { AppStatus, RolloutPreview, SessionSummary, TransferRecord, VaultUsage } from "./types";

const DEMO_SESSION_A = "019d0000-1111-7777-8888-000000000001";
const DEMO_SESSION_B = "019d0000-2222-7777-8888-000000000002";
const DEMO_SESSION_C = "019d0000-3333-7777-8888-000000000003";

export const WEB_DEMO_STATUS: AppStatus = {
  product_name: "codex_session_migration_sync（网页预览）",
  version: "0.1.0",
  codex_home: {
    detected_home: "(网页预览模式)",
    override_home: null,
    effective_home: "(网页预览模式)",
    source: "web",
  },
  app_data_dir: "(网页预览模式)",
  vault_dir: "(网页预览模式)",
  db_path: "(网页预览模式)",
  device: {
    device_id: "web-preview",
    os: "web",
    arch: "n/a",
    hostname: null,
  },
};

export const WEB_DEMO_SESSIONS: SessionSummary[] = [
  {
    id: DEMO_SESSION_A,
    title: "示例对话：导出流程演示",
    rollout_path: "/demo/sessions/2026/02/26/rollout-demo-a.jsonl",
    cwd: "/path/to/project (demo)",
    cli_version: "0.0.0-demo",
    model_provider: "demo",
    mtime_ms: Date.parse("2026-02-26T12:34:56Z"),
    last_event_timestamp: "2026-02-26T12:33:00Z",
    file_size: 1024 * 1024 * 1.2,
  },
  {
    id: DEMO_SESSION_B,
    title: "示例对话：冲突时改ID导入",
    rollout_path: "/demo/sessions/2026/02/25/rollout-demo-b.jsonl",
    cwd: "/path/to/another (demo)",
    cli_version: "0.0.0-demo",
    model_provider: "demo",
    mtime_ms: Date.parse("2026-02-26T10:20:30Z"),
    last_event_timestamp: "2026-02-26T10:18:00Z",
    file_size: 1024 * 420,
  },
  {
    id: DEMO_SESSION_C,
    title: "示例对话：较早的历史会话",
    rollout_path: "/demo/sessions/2026/02/20/rollout-demo-c.jsonl",
    cwd: "/path/to/legacy (demo)",
    cli_version: "0.0.0-demo",
    model_provider: "demo",
    mtime_ms: Date.parse("2026-02-20T09:00:00Z"),
    last_event_timestamp: "2026-02-20T08:59:00Z",
    file_size: 1024 * 12,
  },
];

export const WEB_DEMO_HISTORY: TransferRecord[] = [
  {
    id: "019d1000-aaaa-7777-8888-000000000001",
    created_at: "2026-02-26T12:00:00Z",
    op: "export",
    name: "示例：mac -> win 传递",
    note: "这是网页预览模式的示例数据。",
    tags: "demo, export",
    favorite: true,
    updated_at: null,
    session_id_old: DEMO_SESSION_A,
    session_id_new: null,
    effective_session_id: DEMO_SESSION_A,
    status: "ok",
    error_message: null,
    vault_dir: "/demo/vault/019d1000",
    bundle_path: "/demo/vault/019d1000/bundle.zip",
    vault_rollout_rel_path: "rollout.jsonl",
    rollout_sha256: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    rollout_size: 123456,
    local_rollout_path: "/demo/.codex/sessions/rollout-demo-a.jsonl",
  },
  {
    id: "019d1000-bbbb-7777-8888-000000000002",
    created_at: "2026-02-26T12:10:00Z",
    op: "import",
    name: "示例：win 导入（改ID保留分叉）",
    note: null,
    tags: "demo, import",
    favorite: false,
    updated_at: null,
    session_id_old: DEMO_SESSION_A,
    session_id_new: "019d2000-cccc-7777-8888-000000000999",
    effective_session_id: "019d2000-cccc-7777-8888-000000000999",
    status: "ok",
    error_message: null,
    vault_dir: "/demo/vault/019d1001",
    bundle_path: "/demo/vault/019d1001/bundle.zip",
    vault_rollout_rel_path: "rollout_effective.jsonl",
    rollout_sha256: "beefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead",
    rollout_size: 223344,
    local_rollout_path: "/demo/.codex/sessions/rollout-demo-import.jsonl",
  },
];

export const WEB_DEMO_PREVIEW: RolloutPreview = {
  kind: "demo",
  source: "web-demo",
  session_id: DEMO_SESSION_A,
  stats_scope: "full",
  messages: [
    {
      timestamp: "2026-02-26T12:31:00Z",
      role: "user",
      text: "这是网页预览模式，用于检查界面布局/中文文案。",
      content_types: ["input_text"],
    },
    {
      timestamp: "2026-02-26T12:31:05Z",
      role: "assistant",
      text: "好的。我会在不连接本地数据的情况下展示示例预览。",
      content_types: ["output_text"],
    },
    {
      timestamp: "2026-02-26T12:32:00Z",
      role: "assistant",
      text: "提示：实际功能请在桌面版（Tauri）环境中使用。",
      content_types: ["output_text"],
    },
  ],
  message_counts: { user: 1, assistant: 2 },
  message_counts_preview: { user: 1, assistant: 2 },
  tool_calls: 1,
  tool_call_outputs: 1,
  scanned_offset: 0,
  scanned_bytes: 4096,
  max_messages: 12,
  max_chars_per_message: 2000,
  warning: "网页预览模式：这是示例数据，不会读取本地 CODEX_HOME。",
};

export const WEB_DEMO_VAULT_USAGE: VaultUsage = {
  total_bytes: 1024 * 1024 * 123,
  total_files: 1234,
  items: [
    {
      id: WEB_DEMO_HISTORY[0].id,
      created_at: WEB_DEMO_HISTORY[0].created_at,
      op: WEB_DEMO_HISTORY[0].op,
      name: WEB_DEMO_HISTORY[0].name,
      effective_session_id: WEB_DEMO_HISTORY[0].effective_session_id,
      status: WEB_DEMO_HISTORY[0].status,
      vault_dir: WEB_DEMO_HISTORY[0].vault_dir,
      bytes: 1024 * 1024 * 80,
      files: 18,
    },
    {
      id: WEB_DEMO_HISTORY[1].id,
      created_at: WEB_DEMO_HISTORY[1].created_at,
      op: WEB_DEMO_HISTORY[1].op,
      name: WEB_DEMO_HISTORY[1].name,
      effective_session_id: WEB_DEMO_HISTORY[1].effective_session_id,
      status: WEB_DEMO_HISTORY[1].status,
      vault_dir: WEB_DEMO_HISTORY[1].vault_dir,
      bytes: 1024 * 1024 * 40,
      files: 12,
    },
  ],
};
