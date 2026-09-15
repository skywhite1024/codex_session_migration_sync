import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import * as api from "./lib/api";
import { formatBytes, formatRfc3339, formatTimeMs, shortSha } from "./lib/format";
import { isTauriRuntime } from "./lib/runtime";
import {
  WEB_DEMO_HISTORY,
  WEB_DEMO_PREVIEW,
  WEB_DEMO_SESSIONS,
  WEB_DEMO_STATUS,
  WEB_DEMO_VAULT_USAGE,
} from "./lib/webDemo";
import RolloutPreviewView from "./components/RolloutPreviewView";
import type {
  AppStatus,
  ChangeIdResult,
  ConflictStrategy,
  ExportBundleMode,
  ExportSessionsResult,
  HistoryUpdateParams,
  ImportResult,
  ImportBundlesResult,
  InspectBundleResult,
  InspectBatchZipResult,
  PathRewrite,
  RolloutPreview,
  SessionSummary,
  TransferRecord,
  UpdateCheckResult,
  VaultUsage,
} from "./lib/types";

type TabKey =
  | "sessions"
  | "export"
  | "import"
  | "change_id"
  | "history"
  | "settings";

function toErrorMessage(e: unknown): string {
  const formatAppErrorLike = (o: any): string | null => {
    if (!o || typeof o !== "object") return null;
    const message = typeof o.message === "string" ? o.message : null;
    const code = typeof o.code === "string" ? o.code : null;
    const hint = typeof o.hint === "string" ? o.hint : null;
    if (!message) return null;
    let out = message;
    if (hint) out += `\n建议：${hint}`;
    if (code) out += `\n（错误码：${code}）`;
    return out;
  };

  const tryParseJson = (s: string): any | null => {
    const t = s.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  };

  // Tauri may give us either a structured object, or a stringified JSON.
  if (e instanceof Error) {
    const parsed = tryParseJson(e.message);
    return formatAppErrorLike(parsed) ?? e.message;
  }
  if (typeof e === "string") {
    const parsed = tryParseJson(e);
    return formatAppErrorLike(parsed) ?? e;
  }
  const formatted = formatAppErrorLike(e as any);
  return formatted ?? String(e);
}

const PREVIEW_MAX_MESSAGES_DEFAULT = 10;
const PREVIEW_MAX_MESSAGES_CAP = 1000;
const PREVIEW_LOAD_MORE_STEP = 10;
const PREVIEW_MAX_CHARS_PER_MESSAGE_DEFAULT = 4000;

const UPDATE_AUTO_CHECK_DEFAULT = true;
// Avoid spamming GitHub API; manual check is always available.
const UPDATE_AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const STORAGE_KEY_PREVIEW_MARKDOWN = "codexrelay.preview.markdown";
// v2: reset early-stage defaults (10 / +10), while keeping future persistence.
const STORAGE_KEY_PREVIEW_MAX_MESSAGES = "codexrelay.preview.max_messages.v2";
const STORAGE_KEY_PREVIEW_MAX_CHARS_PER_MESSAGE =
  "codexrelay.preview.max_chars_per_message.v2";
const STORAGE_KEY_PREVIEW_INCLUDE_META = "codexrelay.preview.include_meta.v1";
const STORAGE_KEY_UPDATE_AUTO_CHECK = "codexrelay.update.auto_check.v1";
const STORAGE_KEY_UPDATE_LAST_CHECKED_MS = "codexrelay.update.last_checked_ms.v1";

function ellipsizeMiddle(s: string, head = 44, tail = 28): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function ExpandableMono({
  value,
  minExpandChars = 60,
}: {
  value?: string | null;
  minExpandChars?: number;
}) {
  const s = (value ?? "").trim();
  const [open, setOpen] = useState(false);
  if (!s) return <span className="muted">-</span>;
  const long = s.length >= minExpandChars;
  const shown = !open && long ? ellipsizeMiddle(s) : s;
  return (
    <div className={`expandRow ${open ? "open" : ""}`}>
      <span
        className={`mono small expandText ${open ? "open" : "collapsed"}`}
        title={!open && long ? s : undefined}
      >
        {shown}
      </span>
      {long ? (
        <button
          type="button"
          className="miniBtn"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "收起" : "展开"}
        </button>
      ) : null}
    </div>
  );
}

function parseSessionIdList(input: string): string[] {
  // Extract UUID-like ids from noisy text (paths/commands/markdown etc.).
  const re =
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of input.matchAll(re)) {
    const raw = m[0];
    const id = raw.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function readStorageBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    if (v == null) return fallback;
    return v === "1" || v.toLowerCase() === "true";
  } catch {
    return fallback;
  }
}

function writeStorageBool(key: string, value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore
  }
}

function readStorageInt(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    if (v == null) return fallback;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function writeStorageInt(key: string, value: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // ignore
  }
}

function parseTags(input?: string | null): string[] {
  if (!input) return [];
  // Support both "," and "，".
  const parts = input
    .split(/[,，]/g)
    .map((s) => s.trim())
    .filter(Boolean);
  // Deduplicate while keeping order.
  const uniq: string[] = [];
  for (const p of parts) {
    if (!uniq.includes(p)) uniq.push(p);
  }
  return uniq;
}

function normalizeTagsInput(input: string): string | null {
  const tags = parseTags(input);
  return tags.length ? tags.join(", ") : null;
}

function opZh(op: string): string {
  switch (op) {
    case "export":
      return "导出";
    case "import":
      return "导入";
    case "restore":
      return "恢复";
    case "change_id":
      return "改ID";
    default:
      return op || "-";
  }
}

function statusZh(status: string): string {
  switch (status) {
    case "ok":
      return "成功";
    case "canceled":
      return "已取消";
    case "failed":
      return "失败";
    default:
      return status || "-";
  }
}

function App() {
  const [tab, setTab] = useState<TabKey>("sessions");
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const isTauri = useMemo(() => isTauriRuntime(), []);
  const [previewRenderMarkdown, setPreviewRenderMarkdown] = useState<boolean>(() =>
    readStorageBool(STORAGE_KEY_PREVIEW_MARKDOWN, false),
  );
  const [previewMaxMessages, setPreviewMaxMessages] = useState<number>(() =>
    readStorageInt(STORAGE_KEY_PREVIEW_MAX_MESSAGES, PREVIEW_MAX_MESSAGES_DEFAULT),
  );
  const [previewMaxCharsPerMessage, setPreviewMaxCharsPerMessage] = useState<number>(() =>
    readStorageInt(
      STORAGE_KEY_PREVIEW_MAX_CHARS_PER_MESSAGE,
      PREVIEW_MAX_CHARS_PER_MESSAGE_DEFAULT,
    ),
  );
  const [previewIncludeMeta, setPreviewIncludeMeta] = useState<boolean>(() =>
    readStorageBool(STORAGE_KEY_PREVIEW_INCLUDE_META, false),
  );
  const [updateAutoCheck, setUpdateAutoCheck] = useState<boolean>(() =>
    readStorageBool(STORAGE_KEY_UPDATE_AUTO_CHECK, UPDATE_AUTO_CHECK_DEFAULT),
  );
  const [updateLastCheckedMs, setUpdateLastCheckedMs] = useState<number>(() =>
    readStorageInt(STORAGE_KEY_UPDATE_LAST_CHECKED_MS, 0),
  );
  const [updateCheckBusy, setUpdateCheckBusy] = useState(false);
  const [updateCheckError, setUpdateCheckError] = useState<string | null>(null);
  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckResult | null>(
    null,
  );

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busy = busyAction !== null;
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const updateCheckBusyRef = useRef(false);
  const selectAllSessionsRef = useRef<HTMLInputElement | null>(null);
  const selectAllHistoryRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    writeStorageBool(STORAGE_KEY_PREVIEW_MARKDOWN, previewRenderMarkdown);
  }, [previewRenderMarkdown]);

  useEffect(() => {
    writeStorageInt(STORAGE_KEY_PREVIEW_MAX_MESSAGES, previewMaxMessages);
  }, [previewMaxMessages]);

  useEffect(() => {
    writeStorageInt(STORAGE_KEY_PREVIEW_MAX_CHARS_PER_MESSAGE, previewMaxCharsPerMessage);
  }, [previewMaxCharsPerMessage]);

  useEffect(() => {
    writeStorageBool(STORAGE_KEY_PREVIEW_INCLUDE_META, previewIncludeMeta);
  }, [previewIncludeMeta]);

  useEffect(() => {
    writeStorageBool(STORAGE_KEY_UPDATE_AUTO_CHECK, updateAutoCheck);
  }, [updateAutoCheck]);

  useEffect(() => {
    writeStorageInt(STORAGE_KEY_UPDATE_LAST_CHECKED_MS, updateLastCheckedMs);
  }, [updateLastCheckedMs]);

  useEffect(() => {
    if (!isTauri) return;
    if (!updateAutoCheck) return;
    void runCheckUpdate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTauri, updateAutoCheck]);

  // Drag & Drop (bundle.zip)
  const [dragActive, setDragActive] = useState(false);
  const [dragPaths, setDragPaths] = useState<string[]>([]);

  // Sessions UI
  const [sessionsFilter, setSessionsFilter] = useState("");
  // 项目文件夹筛选：空串=全部；否则只显示 cwd 等于或位于该文件夹下的会话。
  const [sessionsCwdFilter, setSessionsCwdFilter] = useState("");
  const [sessionsDetailOpen, setSessionsDetailOpen] = useState(true);
  const [sessionPreview, setSessionPreview] = useState<RolloutPreview | null>(
    null,
  );
  const [sessionPreviewBusy, setSessionPreviewBusy] = useState(false);
  const [sessionPreviewError, setSessionPreviewError] = useState<string | null>(
    null,
  );
  const [latestTransferBySessionId, setLatestTransferBySessionId] = useState<
    Record<string, TransferRecord>
  >({});

  // Export UI
  const [exportSessionId, setExportSessionId] = useState("");
  const [exportName, setExportName] = useState("");
  const [exportNote, setExportNote] = useState("");
  const [exportIncludeShell, setExportIncludeShell] = useState(false);
  const [exportMode, setExportMode] = useState<ExportBundleMode>("merged");
  const [exportBatchResult, setExportBatchResult] =
    useState<ExportSessionsResult | null>(null);
  const [exportIdsExtractBusy, setExportIdsExtractBusy] = useState(false);
  const [exportIdsExtractInfo, setExportIdsExtractInfo] = useState<string | null>(
    null,
  );

  // Import UI
  const [importBundlePaths, setImportBundlePaths] = useState<string[]>([]);
  const [importPickInfo, setImportPickInfo] = useState<string | null>(null);
  const [inspectResult, setInspectResult] = useState<InspectBundleResult | null>(
    null,
  );
  const [inspectBatchResult, setInspectBatchResult] =
    useState<InspectBatchZipResult | null>(null);
  const [importName, setImportName] = useState("");
  const [importNote, setImportNote] = useState("");
  const [importStrategy, setImportStrategy] =
    useState<ConflictStrategy>("overwrite");
  const [importPathRewrites, setImportPathRewrites] =
    useState<PathRewrite[]>([]);
  const [importBatchResult, setImportBatchResult] =
    useState<ImportBundlesResult | null>(null);
  const [bundlePreview, setBundlePreview] = useState<RolloutPreview | null>(
    null,
  );
  const [bundlePreviewBusy, setBundlePreviewBusy] = useState(false);
  const [bundlePreviewError, setBundlePreviewError] = useState<string | null>(
    null,
  );
  const [bundlePreviewOpen, setBundlePreviewOpen] = useState(true);
  const [batchEntryName, setBatchEntryName] = useState<string>("");
  const [batchEntryPreview, setBatchEntryPreview] = useState<RolloutPreview | null>(
    null,
  );
  const [batchEntryPreviewBusy, setBatchEntryPreviewBusy] = useState(false);
  const [batchEntryPreviewError, setBatchEntryPreviewError] = useState<string | null>(
    null,
  );
  const [batchEntryPreviewOpen, setBatchEntryPreviewOpen] = useState(false);
  const [localExistingPreview, setLocalExistingPreview] =
    useState<RolloutPreview | null>(null);
  const [localExistingPreviewBusy, setLocalExistingPreviewBusy] = useState(false);
  const [localExistingPreviewError, setLocalExistingPreviewError] = useState<
    string | null
  >(null);
  const [localExistingPreviewOpen, setLocalExistingPreviewOpen] = useState(true);

  // Change ID UI
  const [changeIdSessionId, setChangeIdSessionId] = useState("");
  const [changeIdName, setChangeIdName] = useState("");
  const [changeIdNote, setChangeIdNote] = useState("");
  const [changeIdNewId, setChangeIdNewId] = useState("");
  const [changeIdResult, setChangeIdResult] = useState<ChangeIdResult | null>(
    null,
  );

  // History UI
  const [history, setHistory] = useState<TransferRecord[]>([]);
  const [historySelectedId, setHistorySelectedId] = useState<string>("");
  const [historySelectedIds, setHistorySelectedIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const [historyFilter, setHistoryFilter] = useState("");
  const [historyDetailOpen, setHistoryDetailOpen] = useState(true);
  const [historyFavoritesOnly, setHistoryFavoritesOnly] = useState(false);
  const [historyOpFilter, setHistoryOpFilter] = useState<string>("all");
  const [historyDeleteFiles, setHistoryDeleteFiles] = useState(false);
  const [historyEditBusy, setHistoryEditBusy] = useState(false);
  const [historyEditError, setHistoryEditError] = useState<string | null>(null);
  const [historyEditName, setHistoryEditName] = useState("");
  const [historyEditNote, setHistoryEditNote] = useState("");
  const [historyEditTags, setHistoryEditTags] = useState("");
  const [historyEditFavorite, setHistoryEditFavorite] = useState(false);
  const [restoreName, setRestoreName] = useState("");
  const [restoreNote, setRestoreNote] = useState("");
  const [restoreStrategy, setRestoreStrategy] =
    useState<ConflictStrategy>("recommended");
  const [restoreResult, setRestoreResult] = useState<ImportResult | null>(null);
  const [historyPreview, setHistoryPreview] = useState<RolloutPreview | null>(
    null,
  );
  const [historyPreviewBusy, setHistoryPreviewBusy] = useState(false);
  const [historyPreviewError, setHistoryPreviewError] = useState<string | null>(
    null,
  );
  const [historyDetailTab, setHistoryDetailTab] = useState<"detail" | "preview">(
    "detail",
  );

  // Settings UI
  const [codexHomeOverrideInput, setCodexHomeOverrideInput] = useState("");
  const [vaultUsage, setVaultUsage] = useState<VaultUsage | null>(null);
  const [vaultUsageBusy, setVaultUsageBusy] = useState(false);
  const [vaultUsageError, setVaultUsageError] = useState<string | null>(null);
  const [vaultUsageLimit, setVaultUsageLimit] = useState(200);

  async function refreshStatusAndSessions() {
    setBusyAction("refresh");
    setError(null);
    try {
      if (!isTauri) {
        setStatus(WEB_DEMO_STATUS);
        setSessions(WEB_DEMO_SESSIONS);
        const map: Record<string, TransferRecord> = {};
        for (const r of WEB_DEMO_HISTORY) {
          const sid = r.effective_session_id ?? r.session_id_new ?? r.session_id_old;
          if (!sid) continue;
          map[sid] = r;
        }
        setLatestTransferBySessionId(map);
        if (!selectedSessionId && WEB_DEMO_SESSIONS.length) {
          setSelectedSessionId(WEB_DEMO_SESSIONS[0].id);
        }
        return;
      }
      const [s, list] = await Promise.all([api.appStatus(), api.listSessions()]);
      setStatus(s);
      setSessions(list);
      const latest = await api.historyLatestForSessions({
        session_ids: list.map((x) => x.id),
      });
      const map: Record<string, TransferRecord> = {};
      for (const r of latest) {
        const sid = r.effective_session_id ?? r.session_id_new ?? r.session_id_old;
        if (!sid) continue;
        map[sid] = r;
      }
      setLatestTransferBySessionId(map);
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function refreshHistory() {
    setBusyAction("history");
    setError(null);
    try {
      if (!isTauri) {
        setHistory(WEB_DEMO_HISTORY);
        if (WEB_DEMO_HISTORY.length > 0 && !historySelectedId) {
          setHistorySelectedId(WEB_DEMO_HISTORY[0].id);
        }
        return;
      }
      const records = await api.historyList();
      setHistory(records);
      if (records.length > 0 && !historySelectedId) {
        setHistorySelectedId(records[0].id);
      }
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function refreshVaultUsage() {
    setVaultUsageBusy(true);
    setVaultUsageError(null);
    try {
      if (!isTauri) {
        setVaultUsage(WEB_DEMO_VAULT_USAGE);
        return;
      }
      const usage = await api.vaultUsage(vaultUsageLimit);
      setVaultUsage(usage);
    } catch (e) {
      setVaultUsage(null);
      setVaultUsageError(toErrorMessage(e));
    } finally {
      setVaultUsageBusy(false);
    }
  }

  async function loadSessionPreview(rolloutPath: string) {
    setSessionPreviewBusy(true);
    setSessionPreviewError(null);
    try {
      if (!isTauri) {
        setSessionPreview({ ...WEB_DEMO_PREVIEW, source: rolloutPath });
        return;
      }
      const p = await api.previewRollout({
        path: rolloutPath,
        max_messages: previewMaxMessages,
        max_chars_per_message: previewMaxCharsPerMessage,
        include_meta: previewIncludeMeta,
      });
      setSessionPreview(p);
    } catch (e) {
      setSessionPreview(null);
      setSessionPreviewError(toErrorMessage(e));
    } finally {
      setSessionPreviewBusy(false);
    }
  }

  async function loadBundlePreview(bundlePath: string) {
    setBundlePreviewBusy(true);
    setBundlePreviewError(null);
    try {
      if (!isTauri) {
        setBundlePreview({
          ...WEB_DEMO_PREVIEW,
          kind: "bundle",
          source: bundlePath,
        });
        return;
      }
      const p = await api.previewBundle({
        bundle_path: bundlePath,
        max_messages: previewMaxMessages,
        max_chars_per_message: previewMaxCharsPerMessage,
        include_meta: previewIncludeMeta,
      });
      setBundlePreview(p);
    } catch (e) {
      setBundlePreview(null);
      setBundlePreviewError(toErrorMessage(e));
    } finally {
      setBundlePreviewBusy(false);
    }
  }

  async function loadBatchEntryPreview(bundlePath: string, entryName: string) {
    setBatchEntryPreviewBusy(true);
    setBatchEntryPreviewError(null);
    try {
      if (!isTauri) {
        setBatchEntryPreview({
          ...WEB_DEMO_PREVIEW,
          kind: "bundle",
          source: `${bundlePath}::${entryName}`,
        });
        return;
      }
      const p = await api.previewBatchZipEntry({
        bundle_path: bundlePath,
        entry_name: entryName,
        max_messages: previewMaxMessages,
        max_chars_per_message: previewMaxCharsPerMessage,
        include_meta: previewIncludeMeta,
      });
      setBatchEntryPreview(p);
    } catch (e) {
      setBatchEntryPreview(null);
      setBatchEntryPreviewError(toErrorMessage(e));
    } finally {
      setBatchEntryPreviewBusy(false);
    }
  }

  async function loadLocalExistingPreview(rolloutPath: string) {
    setLocalExistingPreviewBusy(true);
    setLocalExistingPreviewError(null);
    try {
      if (!isTauri) {
        setLocalExistingPreview({ ...WEB_DEMO_PREVIEW, source: rolloutPath });
        return;
      }
      const p = await api.previewRollout({
        path: rolloutPath,
        max_messages: previewMaxMessages,
        max_chars_per_message: previewMaxCharsPerMessage,
        include_meta: previewIncludeMeta,
      });
      setLocalExistingPreview(p);
    } catch (e) {
      setLocalExistingPreview(null);
      setLocalExistingPreviewError(toErrorMessage(e));
    } finally {
      setLocalExistingPreviewBusy(false);
    }
  }

  async function loadHistoryPreview(record: TransferRecord) {
    setHistoryPreviewBusy(true);
    setHistoryPreviewError(null);
    try {
      if (!isTauri) {
        setHistoryPreview({
          ...WEB_DEMO_PREVIEW,
          kind: "history",
          source: record.vault_dir,
        });
        return;
      }
      if (record.vault_rollout_rel_path) {
        const p = await join(record.vault_dir, record.vault_rollout_rel_path);
        const r = await api.previewRollout({
          path: p,
          max_messages: previewMaxMessages,
          max_chars_per_message: previewMaxCharsPerMessage,
          include_meta: previewIncludeMeta,
        });
        setHistoryPreview(r);
        return;
      }

      if (record.bundle_path) {
        const r = await api.previewBundle({
          bundle_path: record.bundle_path,
          max_messages: previewMaxMessages,
          max_chars_per_message: previewMaxCharsPerMessage,
          include_meta: previewIncludeMeta,
        });
        setHistoryPreview(r);
        return;
      }

      if (record.local_rollout_path) {
        const r = await api.previewRollout({
          path: record.local_rollout_path,
          max_messages: previewMaxMessages,
          max_chars_per_message: previewMaxCharsPerMessage,
          include_meta: previewIncludeMeta,
        });
        setHistoryPreview(r);
        return;
      }

      setHistoryPreview(null);
      setHistoryPreviewError("缺少可预览的文件路径。");
    } catch (e) {
      setHistoryPreview(null);
      setHistoryPreviewError(toErrorMessage(e));
    } finally {
      setHistoryPreviewBusy(false);
    }
  }

  useEffect(() => {
    refreshStatusAndSessions();
  }, []);

  useEffect(() => {
    let unlisten: null | (() => void) = null;
    (async () => {
      try {
        unlisten = await getCurrentWindow().onDragDropEvent((event) => {
          const payload = event.payload as {
            type: string;
            paths?: string[];
          };
          if (payload.type === "enter") {
            setDragActive(true);
            setDragPaths(payload.paths ?? []);
            return;
          }
          if (payload.type === "over") {
            setDragActive(true);
            return;
          }
          if (payload.type === "leave") {
            setDragActive(false);
            setDragPaths([]);
            return;
          }
          if (payload.type === "drop") {
            setDragActive(false);
            setDragPaths([]);
            void handleDroppedPaths(payload.paths ?? []);
          }
        });
      } catch {
        // Drag & drop is non-critical.
      }
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (tab === "history") {
      refreshHistory();
    }
  }, [tab]);

  useEffect(() => {
    if (tab !== "settings") return;
    if (vaultUsage || vaultUsageBusy) return;
    void refreshVaultUsage();
  }, [tab]);

  useEffect(() => {
    setCodexHomeOverrideInput(status?.codex_home.override_home ?? "");
  }, [status?.codex_home.override_home]);

  useEffect(() => {
    if (tab === "export" && !exportSessionId) {
      const ids = selectedSessionIds.size
        ? Array.from(selectedSessionIds)
        : selectedSessionId
          ? [selectedSessionId]
          : [];
      if (ids.length) setExportSessionId(ids.join("\n"));
    }
    if (tab === "change_id" && !changeIdSessionId && selectedSessionId) {
      setChangeIdSessionId(selectedSessionId);
    }
  }, [tab, selectedSessionId, selectedSessionIds, exportSessionId, changeIdSessionId]);

  // 按工作目录聚合：每个精确 cwd 下有多少个会话，用于文件夹下拉。
  const cwdGroups = useMemo(() => {
    const m = new Map<string, number>();
    for (const sess of sessions) {
      const c = (sess.cwd ?? "").trim();
      if (!c) continue;
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    return Array.from(m, ([cwd, count]) => ({ cwd, count })).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.cwd.localeCompare(b.cwd);
    });
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    const q = sessionsFilter.trim().toLowerCase();
    const root = sessionsCwdFilter.trim();
    // 归一化：统一分隔符、去尾部斜杠、转小写，兼容 Windows 盘符大小写与 / \ 混用。
    const norm = (x: string) => x.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const nRoot = norm(root);
    return sessions.filter((sess) => {
      if (nRoot) {
        const c = norm(sess.cwd ?? "");
        // 边界保护：cwd 等于 root，或 root 之后紧跟路径分隔符才算位于该文件夹下。
        if (c !== nRoot && !c.startsWith(nRoot + "/")) return false;
      }
      if (!q) return true;
      return (
        sess.id.toLowerCase().includes(q) ||
        (sess.title ?? "").toLowerCase().includes(q) ||
        (sess.cwd ?? "").toLowerCase().includes(q)
      );
    });
  }, [sessions, sessionsFilter, sessionsCwdFilter]);

  const filteredSessionsSelection = useMemo(() => {
    if (filteredSessions.length === 0) {
      return { all: false, some: false, selectedCount: 0 };
    }
    let selectedCount = 0;
    for (const s of filteredSessions) {
      if (selectedSessionIds.has(s.id)) selectedCount += 1;
    }
    const all = selectedCount > 0 && selectedCount === filteredSessions.length;
    const some = selectedCount > 0 && selectedCount < filteredSessions.length;
    return { all, some, selectedCount };
  }, [filteredSessions, selectedSessionIds]);

  useEffect(() => {
    if (!selectAllSessionsRef.current) return;
    selectAllSessionsRef.current.indeterminate =
      filteredSessionsSelection.some && !filteredSessionsSelection.all;
  }, [filteredSessionsSelection.some, filteredSessionsSelection.all]);

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  useEffect(() => {
    setSelectedSessionIds((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(sessions.map((s) => s.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  useEffect(() => {
    setHistorySelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(history.map((r) => r.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [history]);

  const exportSessionIds = useMemo(
    () => parseSessionIdList(exportSessionId),
    [exportSessionId],
  );

  const selectedHistory = useMemo(
    () => history.find((r) => r.id === historySelectedId) ?? null,
    [history, historySelectedId],
  );

  useEffect(() => {
    setHistoryEditError(null);
    if (!selectedHistory) return;
    setHistoryEditName(selectedHistory.name ?? "");
    setHistoryEditNote(selectedHistory.note ?? "");
    setHistoryEditTags(selectedHistory.tags ?? "");
    setHistoryEditFavorite(Boolean(selectedHistory.favorite));
  }, [selectedHistory?.id]);

  const filteredHistory = useMemo(() => {
    const q = historyFilter.trim().toLowerCase();
    return history.filter((r) => {
      if (historyFavoritesOnly && !r.favorite) return false;
      if (historyOpFilter !== "all" && r.op !== historyOpFilter) return false;
      if (!q) return true;
      const sid =
        r.effective_session_id ?? r.session_id_new ?? r.session_id_old ?? "";
      const hay = [
        r.id,
        r.created_at,
        r.updated_at ?? "",
        r.op,
        opZh(r.op),
        statusZh(r.status),
        r.name,
        r.note ?? "",
        r.tags ?? "",
        sid,
        r.rollout_sha256 ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [history, historyFilter, historyFavoritesOnly, historyOpFilter]);

  const filteredHistorySelection = useMemo(() => {
    if (filteredHistory.length === 0) {
      return { all: false, some: false, selectedCount: 0 };
    }
    let selectedCount = 0;
    for (const r of filteredHistory) {
      if (historySelectedIds.has(r.id)) selectedCount += 1;
    }
    const all = selectedCount > 0 && selectedCount === filteredHistory.length;
    const some = selectedCount > 0 && selectedCount < filteredHistory.length;
    return { all, some, selectedCount };
  }, [filteredHistory, historySelectedIds]);

  useEffect(() => {
    if (!selectAllHistoryRef.current) return;
    selectAllHistoryRef.current.indeterminate =
      filteredHistorySelection.some && !filteredHistorySelection.all;
  }, [filteredHistorySelection.some, filteredHistorySelection.all]);

  useEffect(() => {
    if (tab !== "history") return;
    if (filteredHistory.length === 0) return;
    if (!historySelectedId || !filteredHistory.some((r) => r.id === historySelectedId)) {
      setHistorySelectedId(filteredHistory[0].id);
    }
  }, [tab, filteredHistory, historySelectedId]);

  useEffect(() => {
    setSessionPreview(null);
    setSessionPreviewError(null);
    if (!sessionsDetailOpen) return;
    if (!selectedSession?.rollout_path) return;
    void loadSessionPreview(selectedSession.rollout_path);
  }, [
    sessionsDetailOpen,
    previewMaxMessages,
    previewMaxCharsPerMessage,
    selectedSession?.rollout_path,
  ]);

  useEffect(() => {
    setBundlePreview(null);
    setBundlePreviewError(null);
    if (!bundlePreviewOpen) return;
    if (!inspectResult) return;
    void loadBundlePreview(inspectResult.bundle_path);
  }, [
    bundlePreviewOpen,
    previewMaxMessages,
    previewMaxCharsPerMessage,
    inspectResult?.bundle_path,
  ]);

  useEffect(() => {
    setBatchEntryPreview(null);
    setBatchEntryPreviewError(null);
    if (!batchEntryPreviewOpen) return;
    if (!inspectBatchResult) return;
    if (!batchEntryName) return;
    void loadBatchEntryPreview(inspectBatchResult.bundle_path, batchEntryName);
  }, [
    batchEntryPreviewOpen,
    previewMaxMessages,
    previewMaxCharsPerMessage,
    inspectBatchResult?.bundle_path,
    batchEntryName,
  ]);

  useEffect(() => {
    setLocalExistingPreview(null);
    setLocalExistingPreviewError(null);
    if (!localExistingPreviewOpen) return;
    const p = inspectResult?.local_existing?.rollout_path;
    if (!p) return;
    void loadLocalExistingPreview(p);
  }, [
    localExistingPreviewOpen,
    previewMaxMessages,
    previewMaxCharsPerMessage,
    inspectResult?.local_existing?.rollout_path,
  ]);

  useEffect(() => {
    setHistoryPreview(null);
    setHistoryPreviewError(null);
    if (tab !== "history") return;
    if (!historyDetailOpen) return;
    if (historyDetailTab !== "preview") return;
    if (!selectedHistory) return;
    void loadHistoryPreview(selectedHistory);
  }, [
    tab,
    historyDetailOpen,
    historyDetailTab,
    previewMaxMessages,
    previewMaxCharsPerMessage,
    selectedHistory?.id,
  ]);

  const inspectHasConflict = useMemo(() => {
    if (!inspectResult?.local_existing) return false;
    return inspectResult.local_existing.sha256 !== inspectResult.manifest.rollout.sha256;
  }, [inspectResult]);

  async function inspectImportBundleFromPath(
    path: string,
    opts?: { autoAdjustImportFields?: boolean },
  ) {
    setError(null);
    setImportBatchResult(null);
    setInspectResult(null);
    setInspectBatchResult(null);
    setBatchEntryName("");
    setBatchEntryPreview(null);
    setBatchEntryPreviewError(null);
    setBatchEntryPreviewOpen(false);
    setBusyAction("inspect");
    try {
      if (!isTauri) {
        setError("网页预览模式不支持导入检查，请在桌面版（Tauri）中使用。");
        return;
      }
      const autoAdjustImportFields = opts?.autoAdjustImportFields ?? true;
      const inspected = await api.inspectBundle(path);
      setInspectResult(inspected);
      if (autoAdjustImportFields) {
        setImportName(`导入：${inspected.manifest.name}`);
        setImportNote(inspected.manifest.note ?? "");
      }

      const hasConflict =
        !!inspected.local_existing &&
        inspected.local_existing.sha256 !== inspected.manifest.rollout.sha256;
      if (autoAdjustImportFields) {
        setImportStrategy(hasConflict ? "import_as_new" : "overwrite");
      }
    } catch (e) {
      // 合并包（外层 zip）不包含 manifest.json/rollout.jsonl，单包检查会失败；
      // 尝试解析 batch_manifest.json 或 bundles/*.zip 列表。
      try {
        const batch = await api.inspectBatchZip(path);
        setInspectBatchResult(batch);
        if (opts?.autoAdjustImportFields ?? true) {
          if (batch.name) setImportName(`导入：${batch.name}`);
          if (batch.note) setImportNote(batch.note);
          setImportStrategy("recommended");
        }
        setBatchEntryName(batch.items[0]?.inner_zip ?? "");
      } catch (e2) {
        setInspectBatchResult(null);
        setError(
          `检查失败：${toErrorMessage(e)}\n提示：支持的结构：单会话导出包（manifest.json + rollout.jsonl），或合并导出包（bundles/*.zip，可选 batch_manifest.json）。\n（合并包解析失败：${toErrorMessage(e2)}）`,
        );
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function handlePickImportBundles() {
    try {
      if (!isTauri) {
        setError("网页预览模式不支持选择文件，请在桌面版（Tauri）中使用。");
        return;
      }
      const selected = await open({
        title: "选择 zip（可多选）",
        multiple: true,
        filters: [{ name: "导出包 (zip)", extensions: ["zip"] }],
      });
      const paths = Array.isArray(selected)
        ? selected
        : selected
          ? [selected]
          : [];
      if (!paths.length) return;
      setError(null);
      setImportPickInfo(`已选择 ${paths.length} 个 zip。`);
      setImportBatchResult(null);
      setInspectResult(null);
      setInspectBatchResult(null);
      setBatchEntryName("");
      setBatchEntryPreview(null);
      setBatchEntryPreviewError(null);
      setBatchEntryPreviewOpen(false);
      setImportBundlePaths(paths);
      // Best-effort inspect the first file so users can preview before importing.
      await inspectImportBundleFromPath(paths[0], {
        autoAdjustImportFields: paths.length === 1,
      });
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }

  async function handlePickExportSessionIdsFile() {
    setError(null);
    setExportIdsExtractInfo(null);
    try {
      if (!isTauri) {
        setError("网页预览模式不支持选择文件，请在桌面版（Tauri）中使用。");
        return;
      }
      const selected = await open({
        title: "选择文本文件（.md / .txt）",
        multiple: false,
        filters: [{ name: "文本文件 (md/txt)", extensions: ["md", "txt"] }],
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;

      setExportIdsExtractBusy(true);
      const r = await api.extractSessionIdsFromFile({
        path,
        max_bytes: 16 * 1024 * 1024,
      });
      setExportSessionId(r.ids.join("\n"));
      if (r.ids.length === 0) {
        setExportIdsExtractInfo("未在文件中识别到会话ID。");
      } else if (r.truncated) {
        setExportIdsExtractInfo(
          `已提取 ${r.ids.length} 个会话ID（文件较大，仅扫描前 ${formatBytes(r.scanned_bytes)}）。`,
        );
      } else {
        setExportIdsExtractInfo(
          `已从文件提取 ${r.ids.length} 个会话ID（扫描 ${formatBytes(r.scanned_bytes)}）。`,
        );
      }
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setExportIdsExtractBusy(false);
    }
  }

  async function handleDroppedPaths(paths: string[]) {
    if (!isTauri) {
      setError("网页预览模式不支持拖拽导入，请在桌面版（Tauri）中使用。");
      return;
    }
    const zips = paths.filter((p) => p.toLowerCase().endsWith(".zip"));
    if (!zips.length) {
      setError("只支持拖入 zip 文件。");
      return;
    }
    if (busyRef.current) {
      setError("当前有任务正在进行中，请稍后再试。");
      return;
    }
    setTab("import");
    setError(null);
    setImportPickInfo(`已选择 ${zips.length} 个 zip。`);
    setImportBatchResult(null);
    setInspectResult(null);
    setInspectBatchResult(null);
    setBatchEntryName("");
    setBatchEntryPreview(null);
    setBatchEntryPreviewError(null);
    setBatchEntryPreviewOpen(false);
    setImportBundlePaths(zips);
    // Best-effort inspect the first file so users can preview before importing.
    await inspectImportBundleFromPath(zips[0], {
      autoAdjustImportFields: zips.length === 1,
    });
  }

  async function handleExport() {
    setError(null);
    setExportBatchResult(null);
    setBusyAction("export");
    try {
      if (!isTauri) {
        setError("网页预览模式不支持导出，请在桌面版（Tauri）中使用。");
        return;
      }
      const ids = parseSessionIdList(exportSessionId);
      if (ids.length === 0) {
        setError("会话ID为必填项。");
        return;
      }
      const baseName = exportName.trim();
      if (!baseName) {
        setError("名称为必填项。");
        return;
      }
      const note = exportNote.trim() ? exportNote.trim() : null;
      const r = await api.exportSessions({
        session_ids: ids,
        name: baseName,
        note,
        include_shell_snapshot: exportIncludeShell,
        mode: exportMode,
      });
      setExportBatchResult(r);
      if (r.items.length) {
        await refreshHistory();
      }
      if (r.errors.length) {
        setError(`部分导出失败：${r.errors.length}/${ids.length}（详见导出结果）。`);
      }
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  function addPathRewrite() {
    setImportPathRewrites((arr) => [...arr, { from: "", to: "" }]);
  }
  function updatePathRewrite(i: number, key: "from" | "to", v: string) {
    setImportPathRewrites((arr) =>
      arr.map((rw, idx) => (idx === i ? { ...rw, [key]: v } : rw)),
    );
  }
  function removePathRewrite(i: number) {
    setImportPathRewrites((arr) => arr.filter((_, idx) => idx !== i));
  }
  async function pickRewriteTarget(i: number) {
    if (!isTauri) {
      setError("网页预览模式不支持选择文件夹，请在桌面版（Tauri）中使用。");
      return;
    }
    const selected = await open({
      title: "选择 B 机上的项目文件夹",
      directory: true,
      multiple: false,
    });
    const picked = Array.isArray(selected) ? selected[0] : selected;
    if (!picked) return;
    updatePathRewrite(i, "to", picked);
  }
  // 会话列表：选择任意文件夹做"位于该文件夹下（含子目录）"筛选。
  async function pickSessionCwdFilter() {
    if (!isTauri) {
      setError("网页预览模式不支持选择文件夹，请在桌面版（Tauri）中使用。");
      return;
    }
    const selected = await open({
      title: "选择要筛选的项目文件夹（含其子目录）",
      directory: true,
      multiple: false,
    });
    const picked = Array.isArray(selected) ? selected[0] : selected;
    if (!picked) return;
    setSessionsCwdFilter(picked);
  }

  async function handleImport() {
    setError(null);
    setImportBatchResult(null);
    setBusyAction("import");
    try {
      if (!isTauri) {
        setError("网页预览模式不支持导入，请在桌面版（Tauri）中使用。");
        return;
      }
      if (importBundlePaths.length === 0) {
        setError("请选择至少一个 zip 文件。");
        return;
      }
      if (!importName.trim()) {
        setError("名称为必填项。");
        return;
      }
      const activeRewrites = importPathRewrites
        .filter((rw) => rw.from.trim() && rw.to.trim())
        .map((rw) => ({ from: rw.from.trim(), to: rw.to.trim() }));
      const r = await api.importBundles({
        bundle_paths: importBundlePaths,
        name: importName.trim(),
        note: importNote.trim() ? importNote.trim() : null,
        strategy: importStrategy,
        path_rewrites: activeRewrites.length ? activeRewrites : null,
      });
      setImportBatchResult(r);
      await refreshStatusAndSessions();
      await refreshHistory();
      if (r.failed) {
        setError(`部分导入失败：${r.failed}（详见导入结果）。`);
      }
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleChangeId() {
    setError(null);
    setChangeIdResult(null);
    setBusyAction("change_id");
    try {
      if (!isTauri) {
        setError("网页预览模式不支持更换会话ID，请在桌面版（Tauri）中使用。");
        return;
      }
      const r = await api.changeSessionId({
        session_id: changeIdSessionId.trim(),
        name: changeIdName.trim(),
        note: changeIdNote.trim() ? changeIdNote.trim() : null,
        new_session_id: changeIdNewId.trim() ? changeIdNewId.trim() : null,
      });
      setChangeIdResult(r);
      await refreshStatusAndSessions();
      await refreshHistory();
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleApplyCodexHomeOverride() {
    setError(null);
    setBusyAction("settings");
    try {
      if (!isTauri) {
        setError("网页预览模式不支持设置 CODEX_HOME，请在桌面版（Tauri）中使用。");
        return;
      }
      const next = await api.setCodexHomeOverride(
        codexHomeOverrideInput.trim() ? codexHomeOverrideInput.trim() : null,
      );
      setStatus(next);
      const list = await api.listSessions();
      setSessions(list);
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleBrowseCodexHomeOverride() {
    setError(null);
    try {
      if (!isTauri) {
        setError("网页预览模式不支持选择目录，请在桌面版（Tauri）中使用。");
        return;
      }
      const selected = await open({
        title: "选择 CODEX_HOME 目录",
        directory: true,
        multiple: false,
      });
      const dir = Array.isArray(selected) ? selected[0] : selected;
      if (!dir) return;
      setCodexHomeOverrideInput(dir);
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }

  async function handleHistoryDelete(recordId: string) {
    if (!isTauri) {
      setError("网页预览模式不支持删除历史记录，请在桌面版（Tauri）中使用。");
      return;
    }
    const ok = window.confirm(
      historyDeleteFiles
        ? "删除这条记录并同时删除存档库文件？此操作不可撤销。"
        : "仅删除这条记录（保留存档库文件）？",
    );
    if (!ok) return;

    setError(null);
    setBusyAction("delete");
    try {
      await api.historyDelete(recordId, historyDeleteFiles);
      setHistorySelectedId("");
      await refreshHistory();
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleHistoryDeleteSelected() {
    if (!isTauri) {
      setError("网页预览模式不支持删除历史记录，请在桌面版（Tauri）中使用。");
      return;
    }
    const ids = Array.from(historySelectedIds);
    if (ids.length === 0) {
      setError("请先在左侧历史列表中勾选要删除的记录。");
      return;
    }
    const ok = window.confirm(
      historyDeleteFiles
        ? `删除选中 ${ids.length} 条记录并同时删除存档库文件？此操作不可撤销。`
        : `仅删除选中 ${ids.length} 条记录（保留存档库文件）？`,
    );
    if (!ok) return;

    setError(null);
    setBusyAction("delete_many");
    try {
      const r = await api.historyDeleteMany(ids, historyDeleteFiles);
      setHistorySelectedId("");
      setHistorySelectedIds(new Set());
      await refreshHistory();
      if (r.failed) {
        const max = 5;
        const detail = r.errors
          .slice(0, max)
          .map((it) => `${it.id}: ${it.message}`)
          .join("\n");
        setError(
          `批量删除部分失败：已删除 ${r.deleted}/${r.requested}。\n失败详情（前 ${Math.min(
            max,
            r.errors.length,
          )} 条）：\n${detail}`,
        );
      }
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  function resetHistoryEditFields() {
    setHistoryEditError(null);
    if (!selectedHistory) return;
    setHistoryEditName(selectedHistory.name ?? "");
    setHistoryEditNote(selectedHistory.note ?? "");
    setHistoryEditTags(selectedHistory.tags ?? "");
    setHistoryEditFavorite(Boolean(selectedHistory.favorite));
  }

  async function handleHistorySaveMeta(recordId: string) {
    setHistoryEditError(null);
    setHistoryEditBusy(true);
    try {
      if (!isTauri) {
        setHistoryEditError("网页预览模式不支持保存元信息，请在桌面版（Tauri）中使用。");
        return;
      }
      const params: HistoryUpdateParams = {
        id: recordId,
        name: historyEditName.trim(),
        note: historyEditNote.trim() ? historyEditNote.trim() : null,
        tags: normalizeTagsInput(historyEditTags),
        favorite: historyEditFavorite,
      };
      const updated = await api.historyUpdate(params);
      setHistory((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      // Sync the edit inputs to what the DB actually saved.
      setHistoryEditName(updated.name ?? "");
      setHistoryEditNote(updated.note ?? "");
      setHistoryEditTags(updated.tags ?? "");
      setHistoryEditFavorite(Boolean(updated.favorite));
    } catch (e) {
      setHistoryEditError(toErrorMessage(e));
    } finally {
      setHistoryEditBusy(false);
    }
  }

  async function handleToggleHistoryFavorite(record: TransferRecord) {
    setError(null);
    try {
      if (!isTauri) {
        setError("网页预览模式不支持收藏操作，请在桌面版（Tauri）中使用。");
        return;
      }
      const updated = await api.historyUpdate({
        id: record.id,
        name: record.name,
        note: record.note ?? null,
        tags: record.tags ?? null,
        favorite: !record.favorite,
      });
      setHistory((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      if (historySelectedId === updated.id) {
        setHistoryEditFavorite(Boolean(updated.favorite));
      }
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }

  async function handleRestoreFromHistory(recordId: string) {
    setError(null);
    setRestoreResult(null);
    setBusyAction("restore");
    try {
      if (!isTauri) {
        setError("网页预览模式不支持恢复，请在桌面版（Tauri）中使用。");
        return;
      }
      const r = await api.restoreFromHistory({
        record_id: recordId,
        name: restoreName.trim(),
        note: restoreNote.trim() ? restoreNote.trim() : null,
        strategy: restoreStrategy,
      });
      setRestoreResult(r);
      await refreshStatusAndSessions();
      await refreshHistory();
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function runCheckUpdate(force: boolean) {
    if (!isTauri) {
      setUpdateCheckError("网页预览模式不支持检查更新，请在桌面版（Tauri）中使用。");
      return;
    }
    if (updateCheckBusyRef.current) return;

    if (!force && updateLastCheckedMs) {
      const age = Date.now() - updateLastCheckedMs;
      if (age >= 0 && age < UPDATE_AUTO_CHECK_INTERVAL_MS) return;
    }

    updateCheckBusyRef.current = true;
    setUpdateCheckBusy(true);
    setUpdateCheckError(null);
    try {
      const r = await api.checkUpdate();
      setUpdateCheckResult(r);
      setUpdateLastCheckedMs(Date.now());
    } catch (e) {
      setUpdateCheckError(toErrorMessage(e));
      setUpdateLastCheckedMs(Date.now());
    } finally {
      updateCheckBusyRef.current = false;
      setUpdateCheckBusy(false);
    }
  }

  async function handleOpenUrl(url: string) {
    setError(null);
    try {
      if (!isTauri) {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      await openUrl(url);
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }

  async function handleReveal(path: string) {
    setError(null);
    try {
      if (!isTauri) {
        setError("网页预览模式不支持打开本地路径，请在桌面版（Tauri）中使用。");
        return;
      }
      await revealItemInDir(path);
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }

  async function handleOpen(path: string) {
    setError(null);
    try {
      if (!isTauri) {
        setError("网页预览模式不支持打开本地路径，请在桌面版（Tauri）中使用。");
        return;
      }
      await openPath(path);
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }

  async function handleCopy(text: string) {
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      setError(`复制到剪贴板失败：${toErrorMessage(e)}`);
    }
  }

  function jumpToHistoryRecord(recordId: string, recordName?: string) {
    setHistoryFilter("");
    setHistoryFavoritesOnly(false);
    setHistoryOpFilter("all");
    setHistorySelectedId(recordId);
    if (recordName) {
      setRestoreName(`恢复：${recordName}`);
      setRestoreNote("");
      setRestoreStrategy("recommended");
      setRestoreResult(null);
    }
    setTab("history");
  }

  function codexHomeSourceLabel(source?: string | null): string {
    switch (source) {
      case "override":
        return "覆盖";
      case "env":
        return "环境变量";
      case "default":
        return "默认";
      default:
        return source ?? "-";
    }
  }

  return (
    <main className="container">
      <header className="header">
        <div>
          <h1>codex_session_migration_sync</h1>
          <div className="muted">
            {status ? (
              <>
                <span>
                  {status.product_name} {status.version}
                  {updateCheckResult?.has_update ? (
                    <button
                      type="button"
                      className="pill warn pillBtn"
                      title={`发现新版本：${updateCheckResult.latest_version}`}
                      onClick={() => setTab("settings")}
                    >
                      有更新 {updateCheckResult.latest_version}
                    </button>
                  ) : null}
                </span>
                <span className="dot">•</span>
                <span>
                  CODEX_HOME：
                  <span className="mono">{status.codex_home.effective_home}</span>{" "}
                  <span className="pill">
                    {codexHomeSourceLabel(status.codex_home.source)}
                  </span>
                </span>
              </>
            ) : (
              <span>加载中...</span>
            )}
          </div>
        </div>
        <div className="actions">
          <button
            onClick={refreshStatusAndSessions}
            disabled={busy}
            type="button"
          >
            {busyAction === "refresh" ? "刷新中..." : "刷新"}
          </button>
        </div>
      </header>

      <nav className="tabs">
        <button
          type="button"
          className={tab === "sessions" ? "tab active" : "tab"}
          onClick={() => setTab("sessions")}
        >
          会话
        </button>
        <button
          type="button"
          className={tab === "export" ? "tab active" : "tab"}
          onClick={() => setTab("export")}
        >
          导出
        </button>
        <button
          type="button"
          className={tab === "import" ? "tab active" : "tab"}
          onClick={() => setTab("import")}
        >
          导入
        </button>
        <button
          type="button"
          className={tab === "change_id" ? "tab active" : "tab"}
          onClick={() => setTab("change_id")}
        >
          更换会话ID
        </button>
        <button
          type="button"
          className={tab === "history" ? "tab active" : "tab"}
          onClick={() => setTab("history")}
        >
          历史
        </button>
        <button
          type="button"
          className={tab === "settings" ? "tab active" : "tab"}
          onClick={() => setTab("settings")}
        >
          设置
        </button>
      </nav>

      {error ? <div className="error">错误：{error}</div> : null}
      {!isTauri ? (
        <div className="previewWarn">
          网页预览模式：用于查看界面排版/中文文案，不会读取本地{" "}
          <code>CODEX_HOME</code>；导入/导出/恢复等功能请使用桌面版（Tauri）。
        </div>
      ) : null}

      {tab === "sessions" ? (
        <section className="panel">
	          <div className="panelHeader">
	            <h2>会话列表</h2>
	            <div className="row">
	              <input
	                value={sessionsFilter}
	                onChange={(e) => setSessionsFilter(e.target.value)}
	                placeholder="搜索 标题 / 会话ID / 工作目录..."
	                className="grow"
	              />
	              <select
	                value={cwdGroups.some((g) => g.cwd === sessionsCwdFilter) ? sessionsCwdFilter : sessionsCwdFilter ? "__custom__" : ""}
	                onChange={(e) => setSessionsCwdFilter(e.target.value)}
	                title="按项目工作目录筛选"
	              >
	                <option value="">全部文件夹（{sessions.length}）</option>
	                {sessionsCwdFilter && !cwdGroups.some((g) => g.cwd === sessionsCwdFilter) ? (
	                  <option value="__custom__" title={sessionsCwdFilter}>
	                    {sessionsCwdFilter}（所选文件夹）
	                  </option>
	                ) : null}
	                {cwdGroups.map((g) => (
	                  <option key={g.cwd} value={g.cwd} title={g.cwd}>
	                    {g.cwd}（{g.count}）
	                  </option>
	                ))}
	              </select>
	              <button type="button" onClick={pickSessionCwdFilter} title="选择任意文件夹，筛选其下（含子目录）的全部会话">
	                选文件夹
	              </button>
	              {sessionsCwdFilter ? (
	                <button type="button" onClick={() => setSessionsCwdFilter("")}>
	                  清除筛选
	                </button>
	              ) : null}
	              <button
	                type="button"
	                  className="sideToggleBtn"
                  data-open={sessionsDetailOpen ? "1" : "0"}
	                  title={sessionsDetailOpen ? "折叠右侧面板" : "展开右侧面板"}
	                  aria-label={sessionsDetailOpen ? "折叠右侧面板" : "展开右侧面板"}
		                onClick={() => {
		                  const next = !sessionsDetailOpen;
		                  setSessionsDetailOpen(next);
		                  if (!next) {
		                    setSessionPreview(null);
		                    setSessionPreviewError(null);
		                  }
		                }}
	              >
	                <span className="sideChevron" aria-hidden="true" />
	              </button>
	            </div>
	          </div>

          {sessions.length === 0 ? (
            <div className="muted">
              {busyAction === "refresh" ? (
                "加载中..."
              ) : (
                <>
                  在 <code>CODEX_HOME/sessions</code> 下未找到会话。
                </>
              )}
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="muted">没有匹配会话。</div>
	          ) : (
	            <div className={sessionsDetailOpen ? "split" : "split splitCollapsed"}>
	              <div className="splitList">
	                <div className="tableWrap">
	                  <table className="table clickable">
		                    <thead>
		                      <tr>
		                        <th className="nowrap">
		                          <input
		                            ref={selectAllSessionsRef}
		                            type="checkbox"
		                            checked={filteredSessionsSelection.all}
		                            onChange={(e) => {
		                              const checked = e.target.checked;
		                              setSelectedSessionIds((prev) => {
		                                const next = new Set(prev);
		                                for (const s of filteredSessions) {
		                                  if (checked) next.add(s.id);
		                                  else next.delete(s.id);
		                                }
		                                return next;
		                              });
		                            }}
		                          />
		                        </th>
		                        <th>文件更新时间</th>
		                        <th>标题 / 会话ID</th>
		                        <th>最后事件时间</th>
		                        <th>大小</th>
	                        <th>同步</th>
	                        <th>工作目录</th>
	                        <th>CLI</th>
	                        <th>模型提供方</th>
	                      </tr>
	                    </thead>
	                    <tbody>
		                      {filteredSessions.map((s) => {
		                        const selected = s.id === selectedSessionId;
		                        const checked = selectedSessionIds.has(s.id);
		                        const last = latestTransferBySessionId[s.id];
	                        const lastOpLabel = last ? opZh(last.op) : "-";
	                        const lastAtLabel = last ? formatRfc3339(last.created_at) : "-";
	                        const lastAtMs = last ? Date.parse(last.created_at) : NaN;
	                        const sizeChanged =
	                          last?.rollout_size != null &&
	                          s.file_size != null &&
	                          last.rollout_size !== s.file_size;
	                        const mtimeChanged =
	                          Number.isFinite(lastAtMs) &&
	                          s.mtime_ms != null &&
	                          s.mtime_ms > lastAtMs + 2000;
	                        const changed = Boolean(last) && (sizeChanged || mtimeChanged);
		                        return (
		                          <tr
		                            key={s.rollout_path}
		                            className={selected ? "selectedRow" : undefined}
		                            onClick={() => setSelectedSessionId(s.id)}
		                          >
		                            <td className="nowrap">
		                              <input
		                                type="checkbox"
		                                checked={checked}
		                                onClick={(e) => e.stopPropagation()}
		                                onChange={(e) => {
		                                  const nextChecked = e.target.checked;
		                                  setSelectedSessionIds((prev) => {
		                                    const next = new Set(prev);
		                                    if (nextChecked) next.add(s.id);
		                                    else next.delete(s.id);
		                                    return next;
		                                  });
		                                }}
		                              />
		                            </td>
		                            <td className="nowrap">{formatTimeMs(s.mtime_ms)}</td>
		                            <td className="small">
  <div className="sessionTitle" title={s.title ?? s.id}>
    {s.title && s.title.trim() ? s.title : <span className="muted">（无标题）</span>}
  </div>
  <div className="mono dim sessionIdLine" title={s.id}>
    {s.id}
  </div>
</td>
	                            <td className="nowrap">
	                              {formatRfc3339(s.last_event_timestamp)}
	                            </td>
	                            <td className="nowrap">{formatBytes(s.file_size)}</td>
	                            <td className="nowrap">
	                              {last ? (
	                                <span
	                                  className={changed ? "pill warn" : "pill ok"}
	                                  title={`最近记录：${lastOpLabel} @ ${lastAtLabel}`}
	                                >
	                                  {changed ? "已变化" : "未变化"}
	                                </span>
	                              ) : (
	                                <span className="pill" title="没有找到历史记录">
	                                  未纳管
	                                </span>
	                              )}
	                            </td>
	                            <td className="truncate" title={s.cwd ?? ""}>
	                              {s.cwd ?? "-"}
	                            </td>
	                            <td className="nowrap">{s.cli_version ?? "-"}</td>
	                            <td className="nowrap">{s.model_provider ?? "-"}</td>
	                          </tr>
	                        );
	                      })}
                    </tbody>
                  </table>
                </div>

	                <div className="panelFooter">
	                  <div className="muted">
	                    显示 <span className="mono">{filteredSessions.length}</span> / {sessions.length} 个
	                    <span className="dot">•</span>
	                    当前：{" "}
	                    <span className="mono">{selectedSessionId ? selectedSessionId : "-"}</span>
	                    <span className="dot">•</span>
	                    勾选： <span className="mono">{selectedSessionIds.size}</span>
	                    {selectedSessionId ? (
	                      <>
	                        <span className="dot">•</span>
	                        <span className="mono">codex resume {selectedSessionId}</span>
	                      </>
	                    ) : null}
	                  </div>
                  <div className="row">
                    <button
                      type="button"
                      disabled={!selectedSessionId}
                      onClick={() => handleCopy(`codex resume ${selectedSessionId}`)}
                    >
                      复制恢复命令
                    </button>
                    <button
                      type="button"
                      disabled={!isTauri || !selectedSession?.rollout_path}
                      onClick={() =>
                        selectedSession?.rollout_path
                          ? handleReveal(selectedSession.rollout_path)
                          : null
                      }
                    >
                      显示会话文件
                    </button>
	                    <button
	                      type="button"
	                      disabled={!selectedSessionId && selectedSessionIds.size === 0}
	                      onClick={() => {
	                        const ids = selectedSessionIds.size
	                          ? Array.from(selectedSessionIds)
	                          : selectedSessionId
	                            ? [selectedSessionId]
	                            : [];
	                        setExportSessionId(ids.join("\n"));
	                        setTab("export");
	                      }}
	                    >
	                      导出选中会话
	                    </button>
                    <button
                      type="button"
                      disabled={!selectedSessionId}
                      onClick={() => setTab("change_id")}
                    >
                      更换会话ID
                    </button>
                  </div>
                </div>
              </div>

	              {sessionsDetailOpen ? (
	                <div className="splitDetail">
	                <div className="row sectionHeader">
	                  <h3 className="grow">预览（最近消息）</h3>
	                </div>
	                {selectedSession ? (
	                  <>
	                    <div className="row">
	                      <button
	                        type="button"
	                        disabled={sessionPreviewBusy}
	                        onClick={() => loadSessionPreview(selectedSession.rollout_path)}
	                      >
	                        {sessionPreviewBusy ? "预览中..." : "刷新预览"}
	                      </button>
	                      <button
	                        type="button"
	                        disabled={
	                          sessionPreviewBusy ||
	                          previewMaxMessages >= PREVIEW_MAX_MESSAGES_CAP
	                        }
	                        onClick={() =>
	                          setPreviewMaxMessages((v) =>
	                            Math.min(PREVIEW_MAX_MESSAGES_CAP, v + PREVIEW_LOAD_MORE_STEP),
	                          )
	                        }
	                      >
	                        加载更多（+{PREVIEW_LOAD_MORE_STEP}）
	                      </button>
	                      <button
	                        type="button"
	                        disabled={
	                          sessionPreviewBusy ||
	                          previewMaxMessages === PREVIEW_MAX_MESSAGES_DEFAULT
	                        }
	                        onClick={() => setPreviewMaxMessages(PREVIEW_MAX_MESSAGES_DEFAULT)}
	                      >
	                        重置
	                      </button>
	                      <span className="muted small">
	                        当前显示最近 {previewMaxMessages} 条
	                      </span>
	                      <span
	                        className="mono small truncatePath"
	                        title={selectedSession.rollout_path}
	                      >
	                        {selectedSession.rollout_path}
	                      </span>
	                    </div>
	                    {sessionPreviewError ? (
	                      <div className="error">预览失败：{sessionPreviewError}</div>
	                    ) : null}
	                    {sessionPreview ? (
	                      <RolloutPreviewView
	                        preview={sessionPreview}
	                        renderMarkdown={previewRenderMarkdown}
	                      />
	                    ) : (
	                      <div className="muted small">
	                        自动预览最近 {previewMaxMessages} 条消息（从文件尾部扫描）。
	                      </div>
	                    )}
	                  </>
	                ) : (
	                  <div className="muted">请选择一个会话以查看预览。</div>
	                )}
	              </div>
	              ) : null}
	            </div>
	          )}
	        </section>
	      ) : null}

		      {tab === "export" ? (
		        <section className="panel">
			          <h2>导出</h2>
			          <div className="row">
			            <button
			              type="button"
			              disabled={selectedSessionIds.size === 0}
			              onClick={() =>
			                setExportSessionId(Array.from(selectedSessionIds).join("\n"))
			              }
			            >
			              从会话列表带入勾选（{selectedSessionIds.size}）
			            </button>
			            <button
			              type="button"
			              disabled={!isTauri || exportIdsExtractBusy}
			              onClick={handlePickExportSessionIdsFile}
			            >
			              {exportIdsExtractBusy ? "提取中..." : "从 md/txt 提取会话ID"}
			            </button>
			            <button
			              type="button"
			              disabled={exportSessionIds.length === 0}
			              onClick={() => {
			                setExportSessionId(exportSessionIds.join("\n"));
			                setExportIdsExtractInfo(
			                  `已清洗并提取 ${exportSessionIds.length} 个会话ID。`,
			                );
			              }}
			            >
			              清洗为ID列表
			            </button>
			            <span className="muted small">
			              已识别 {exportSessionIds.length} 个会话ID
			            </span>
			          </div>
			          {exportIdsExtractInfo ? (
			            <div className="previewWarn">{exportIdsExtractInfo}</div>
			          ) : null}
			          <div className="grid">
			            <label className="field">
			              <div className="label">会话ID（可多条，每行一个）</div>
			              <textarea
			                value={exportSessionId}
			                onChange={(e) => {
			                  setExportSessionId(e.target.value);
			                  setExportIdsExtractInfo(null);
			                }}
			                placeholder="例如：019bf3ba-8b3f-7ef1-b1f1-212573c83872\n也支持粘贴包含无关文字的文本：会自动识别其中的会话ID"
			                rows={4}
			              />
			              <div className="hint muted">
			                支持空格/逗号/换行分隔，或直接粘贴“带噪声文本”；将自动识别 UUID 样式会话ID并去重。
			                批量导出时会自动在名称后追加短ID。
			              </div>
			            </label>
		            <label className="field">
		              <div className="label">名称（必填）</div>
		              <input
	                value={exportName}
	                onChange={(e) => setExportName(e.target.value)}
	                placeholder="例如：mac->win 兼容修复"
	              />
	            </label>
	            <label className="field">
	              <div className="label">备注</div>
	              <input
	                value={exportNote}
	                onChange={(e) => setExportNote(e.target.value)}
	                placeholder="可选"
	              />
	            </label>
	            <label className="field">
	              <div className="label">导出包数量</div>
	              <select
	                value={exportMode}
	                onChange={(e) => setExportMode(e.target.value as ExportBundleMode)}
	                disabled={!isTauri}
	              >
	                <option value="merged">合并为一个 zip（默认，推荐）</option>
	                <option value="per_session">每个会话单独一个 zip</option>
	              </select>
	              <div className="hint muted">
	                默认导出到系统下载目录（Downloads）。
	              </div>
	            </label>
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={exportIncludeShell}
                onChange={(e) => setExportIncludeShell(e.target.checked)}
                disabled={!isTauri}
	              />
	              <span>
	                打包 <code>shell_snapshot.sh</code>（可能包含环境变量/路径）
	              </span>
	            </label>
	          </div>
		          <div className="row">
		            <button
		              type="button"
		              disabled={
		                !isTauri || busy || exportSessionIds.length === 0 || !exportName.trim()
		              }
		              onClick={handleExport}
		            >
		              {busyAction === "export"
		                ? "导出中..."
		                : exportSessionIds.length > 1
		                  ? exportMode === "merged"
		                    ? "生成合并导出包"
		                    : "生成多个导出包"
		                  : "生成导出包"}
		            </button>
		          </div>
	
	          {exportBatchResult ? (
	            <div className="result">
	              <h3>导出结果</h3>
	              <div className="kv">
	                <div>输出目录</div>
	                <div className="mono">{exportBatchResult.export_dir}</div>
	                <div>模式</div>
	                <div>
	                  {exportBatchResult.mode === "merged"
	                    ? "合并为一个 zip"
	                    : "每个会话单独 zip"}
	                </div>
	                {exportBatchResult.merged_bundle_path ? (
	                  <>
	                    <div>导出包</div>
	                    <div className="mono">{exportBatchResult.merged_bundle_path}</div>
	                  </>
	                ) : null}
	              </div>
	              {exportBatchResult.merged_bundle_path ? (
	                <div className="row">
	                  <button
	                    type="button"
	                    onClick={() => handleReveal(exportBatchResult.merged_bundle_path!)}
	                  >
	                    显示导出包
	                  </button>
	                </div>
	              ) : null}
	              {exportBatchResult.errors.length ? (
	                <div className="error">
	                  <div>以下会话导出失败：</div>
	                  <pre className="mono small">
	                    {exportBatchResult.errors
	                      .map((e) => `${e.session_id}: ${e.message}`)
	                      .join("\n")}
	                  </pre>
	                </div>
	              ) : null}
	              {exportBatchResult.items.map((r) => (
	                <div className="resultBlock" key={r.transfer_id}>
	                  <div className="kv">
	                    <div>会话ID</div>
	                    <div className="mono">{r.session_id}</div>
	                    <div>导出包</div>
	                    <div className="mono">
	                      {r.exported_bundle_path ??
	                        (exportBatchResult.merged_bundle_path
	                          ? "（已合并到单个 zip）"
	                          : r.vault_bundle_path)}
	                    </div>
	                    <div>存档库</div>
	                    <div className="mono">{r.vault_dir}</div>
	                    <div>SHA256</div>
	                    <div className="mono">{r.manifest.rollout.sha256}</div>
	                    <div>恢复命令</div>
	                    <div className="mono">{r.resume_cmd}</div>
	                  </div>
	                  <div className="row">
	                    <button
	                      type="button"
	                      onClick={() =>
	                        handleReveal(
	                          r.exported_bundle_path ??
	                            exportBatchResult.merged_bundle_path ??
	                            r.vault_bundle_path,
	                        )
	                      }
	                    >
	                      显示导出包
	                    </button>
	                    <button
	                      type="button"
	                      onClick={() => handleCopy(r.resume_cmd)}
	                    >
	                      复制恢复命令
	                    </button>
	                    <button
	                      type="button"
	                      onClick={() => handleOpen(r.vault_dir)}
	                    >
	                      打开存档库
	                    </button>
	                  </div>
	                </div>
	              ))}
	            </div>
	          ) : null}
	        </section>
	      ) : null}

      {tab === "import" ? (
        <section className="panel">
          <h2>导入</h2>
	          <div className="row">
	            <button
	              type="button"
	              onClick={handlePickImportBundles}
	              disabled={!isTauri || busy}
	            >
	              {busyAction === "inspect" ? "检查中..." : "选择 zip（可多选）"}
	            </button>
	            {importBundlePaths.length ? (
	              <span
	                className="mono small truncatePath"
	                title={importBundlePaths.join("\n")}
	              >
	                {importBundlePaths.length === 1
	                  ? importBundlePaths[0]
	                  : `已选择 ${importBundlePaths.length} 个 zip`}
	              </span>
	            ) : null}
	          </div>
	          <div className="hint muted small">
	            {isTauri
	              ? "也可以直接把 zip 文件拖进窗口（支持多选/合并包）。"
	              : "提示：拖拽/选择文件仅桌面版（Tauri）可用。"}
	          </div>
	          {importPickInfo ? (
	            <div className="previewWarn">{importPickInfo}</div>
	          ) : null}

            {importBundlePaths.length > 1 ? (
              <div className="result">
                <h3>已选 zip（点击可检查/预览）</h3>
                <div className="tableWrap">
                  <table className="table compact clickable">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>路径</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importBundlePaths.map((p, idx) => {
                        const inspectedPath =
                          inspectResult?.bundle_path ??
                          inspectBatchResult?.bundle_path ??
                          "";
                        const active = inspectedPath && inspectedPath === p;
                        return (
                          <tr
                            key={`${p}-${idx}`}
                            className={active ? "selectedRow" : undefined}
                            onClick={() =>
                              void inspectImportBundleFromPath(p, {
                                autoAdjustImportFields: false,
                              })
                            }
                          >
                            <td className="nowrap">{idx + 1}</td>
                            <td className="mono small truncatePath" title={p}>
                              {p}
                            </td>
                            <td className="nowrap">
                              <button
                                type="button"
                                disabled={!isTauri || busyAction === "inspect"}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void inspectImportBundleFromPath(p, {
                                    autoAdjustImportFields: false,
                                  });
                                }}
                              >
                                {busyAction === "inspect" && active
                                  ? "检查中..."
                                  : "检查"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="hint muted small">
                  批量导入时，名称/备注/策略对本次导入中所有 zip 生效。
                </div>
              </div>
            ) : null}

	          {inspectResult ? (
            <div className="result">
		              <h3>包信息</h3>
		              <div className="kv">
		                <div>名称</div>
		                <div>{inspectResult.manifest.name}</div>
		                <div>备注</div>
		                <div>{inspectResult.manifest.note ?? "-"}</div>
		                <div>会话ID</div>
		                <div className="mono">{inspectResult.manifest.session_id}</div>
		                <div>创建时间</div>
		                <div>{formatRfc3339(inspectResult.manifest.created_at)}</div>
		                <div>最后事件</div>
		                <div>{formatRfc3339(inspectResult.rollout_last_event_timestamp)}</div>
		                <div>工作目录</div>
		                <div className="truncate" title={inspectResult.manifest.codex.cwd ?? ""}>
		                  <span className="mono small">
		                    {inspectResult.manifest.codex.cwd ?? "-"}
		                  </span>
		                </div>
		                <div>CLI / 模型提供方</div>
		                <div>
		                  <span className="mono small">
		                    {inspectResult.manifest.codex.cli_version ?? "-"}
		                  </span>
		                  <span className="dot">•</span>
		                  <span className="mono small">
		                    {inspectResult.manifest.codex.model_provider ?? "-"}
		                  </span>
		                </div>
		                <div>SHA256</div>
		                <div className="mono">{inspectResult.manifest.rollout.sha256}</div>
		                <div>大小</div>
		                <div>{formatBytes(inspectResult.manifest.rollout.size)}</div>
		                <div>完整性</div>
	                <div>
	                  {inspectResult.sha256_ok ? (
	                    <span className="pill ok">校验通过</span>
	                  ) : (
	                    <span className="pill warn">校验失败</span>
		                  )}
		                </div>
		                <div>本机状态</div>
	                <div>
	                  {inspectResult.local_existing ? (
	                    <>
		                      <span className="mono">
		                        {shortSha(inspectResult.local_existing.sha256)}
	                      </span>
	                      {inspectHasConflict ? (
	                        <span className="pill warn">冲突</span>
	                      ) : (
	                        <span className="pill ok">相同</span>
	                      )}
	                    </>
		                  ) : (
		                    <span className="muted">未找到</span>
		                  )}
		                </div>
		                {inspectResult.local_existing ? (
		                  <>
		                    <div>本机更新时间</div>
		                    <div>{formatTimeMs(inspectResult.local_existing.mtime_ms)}</div>
		                    <div>本机最后事件</div>
		                    <div>{formatRfc3339(inspectResult.local_existing.last_event_timestamp)}</div>
		                    <div>本机工作目录</div>
		                    <div
		                      className="truncate"
		                      title={inspectResult.local_existing.cwd ?? ""}
	                    >
	                      <span className="mono small">
		                        {inspectResult.local_existing.cwd ?? "-"}
		                      </span>
		                    </div>
		                    <div>本机路径</div>
		                    <div
		                      className="truncate"
		                      title={inspectResult.local_existing.rollout_path}
	                    >
	                      <span className="mono small">
		                        {inspectResult.local_existing.rollout_path}
		                      </span>
		                    </div>
		                  </>
		                ) : null}
			              </div>

			              {inspectHasConflict ? (
			                <>
			                  <h3>冲突对比</h3>
			                  <div className="compare">
			                    <div className="compareCard">
			                      <h4>导入包版本</h4>
				                      <div className="kv">
				                        <div>创建时间</div>
				                        <div>{formatRfc3339(inspectResult.manifest.created_at)}</div>
				                        <div>最后事件</div>
				                        <div>{formatRfc3339(inspectResult.rollout_last_event_timestamp)}</div>
			                        <div>SHA256</div>
			                        <div className="mono">
			                          {shortSha(inspectResult.manifest.rollout.sha256)}
			                        </div>
				                        <div>大小</div>
				                        <div>{formatBytes(inspectResult.manifest.rollout.size)}</div>
				                      </div>
				                      <div className="row sectionHeader">
				                        <div className="grow muted small">
				                          预览（最近消息）
				                        </div>
				                        <button
				                          type="button"
				                          onClick={() => setBundlePreviewOpen((v) => !v)}
				                        >
				                          {bundlePreviewOpen ? "折叠预览" : "展开预览"}
				                        </button>
				                      </div>
				                      {bundlePreviewOpen ? (
				                        <>
					                          <div className="row">
					                            <button
					                              type="button"
					                              disabled={bundlePreviewBusy}
					                              onClick={() =>
					                                loadBundlePreview(inspectResult.bundle_path)
					                              }
					                            >
					                              {bundlePreviewBusy ? "预览中..." : "刷新预览"}
					                            </button>
					                            <button
					                              type="button"
					                              disabled={
					                                bundlePreviewBusy ||
					                                previewMaxMessages >= PREVIEW_MAX_MESSAGES_CAP
					                              }
					                              onClick={() =>
					                                setPreviewMaxMessages((v) =>
					                                  Math.min(
					                                    PREVIEW_MAX_MESSAGES_CAP,
					                                    v + PREVIEW_LOAD_MORE_STEP,
					                                  ),
					                                )
					                              }
					                            >
					                              加载更多（+{PREVIEW_LOAD_MORE_STEP}）
					                            </button>
					                            <button
					                              type="button"
					                              disabled={
					                                bundlePreviewBusy ||
					                                previewMaxMessages === PREVIEW_MAX_MESSAGES_DEFAULT
					                              }
					                              onClick={() =>
					                                setPreviewMaxMessages(PREVIEW_MAX_MESSAGES_DEFAULT)
					                              }
					                            >
					                              重置
					                            </button>
					                            <span className="muted small">
					                              当前显示最近 {previewMaxMessages} 条
					                            </span>
					                            <span className="hint muted">
					                              提示：zip 预览需要扫描整个文件，较大的会话可能会比较慢。
					                            </span>
					                          </div>
				                          {bundlePreviewError ? (
				                            <div className="error">
				                              预览失败：{bundlePreviewError}
				                            </div>
				                          ) : null}
				                          {bundlePreview ? (
				                            <RolloutPreviewView
				                              preview={bundlePreview}
				                              renderMarkdown={previewRenderMarkdown}
				                            />
				                          ) : bundlePreviewBusy ? (
				                            <div className="muted">预览加载中...</div>
				                          ) : (
				                            <div className="muted small">
				                              自动预览最近 {previewMaxMessages} 条消息。
				                            </div>
				                          )}
				                        </>
				                      ) : (
				                        <div className="muted small">
				                          已折叠：不会加载预览内容（点击“展开”加载）。
				                        </div>
				                      )}
				                    </div>

			                    <div className="compareCard">
			                      <h4>本机版本</h4>
			                      {inspectResult.local_existing ? (
			                        <>
			                          <div className="kv">
			                            <div>更新时间</div>
			                            <div>
			                              {formatTimeMs(
			                                inspectResult.local_existing.mtime_ms,
			                              )}
			                            </div>
			                            <div>最后事件</div>
			                            <div>
			                              {formatRfc3339(
			                                inspectResult.local_existing.last_event_timestamp,
			                              )}
			                            </div>
			                            <div>SHA256</div>
			                            <div className="mono">
			                              {shortSha(inspectResult.local_existing.sha256)}
			                            </div>
			                            <div>大小</div>
			                            <div>
			                              {formatBytes(inspectResult.local_existing.size)}
			                            </div>
				                          </div>
				                          <div className="row sectionHeader">
				                            <div className="grow muted small">
				                              预览（最近消息）
				                            </div>
				                            <button
				                              type="button"
				                              onClick={() =>
				                                setLocalExistingPreviewOpen((v) => !v)
				                              }
				                            >
				                              {localExistingPreviewOpen ? "折叠预览" : "展开预览"}
				                            </button>
				                          </div>
				                          {localExistingPreviewOpen ? (
				                            <>
					                              <div className="row">
					                                <button
					                                  type="button"
					                                  disabled={localExistingPreviewBusy}
					                                  onClick={() =>
					                                    loadLocalExistingPreview(
					                                      inspectResult.local_existing!.rollout_path,
					                                    )
					                                  }
					                                >
					                                  {localExistingPreviewBusy
					                                    ? "预览中..."
					                                    : "刷新预览"}
					                                </button>
					                                <button
					                                  type="button"
					                                  disabled={
					                                    localExistingPreviewBusy ||
					                                    previewMaxMessages >= PREVIEW_MAX_MESSAGES_CAP
					                                  }
					                                  onClick={() =>
					                                    setPreviewMaxMessages((v) =>
					                                      Math.min(
					                                        PREVIEW_MAX_MESSAGES_CAP,
					                                        v + PREVIEW_LOAD_MORE_STEP,
					                                      ),
					                                    )
					                                  }
					                                >
					                                  加载更多（+{PREVIEW_LOAD_MORE_STEP}）
					                                </button>
					                                <button
					                                  type="button"
					                                  disabled={
					                                    localExistingPreviewBusy ||
					                                    previewMaxMessages === PREVIEW_MAX_MESSAGES_DEFAULT
					                                  }
					                                  onClick={() =>
					                                    setPreviewMaxMessages(PREVIEW_MAX_MESSAGES_DEFAULT)
					                                  }
					                                >
					                                  重置
					                                </button>
					                                <span className="muted small">
					                                  当前显示最近 {previewMaxMessages} 条
					                                </span>
					                                <span
					                                  className="mono small truncatePath"
					                                  title={inspectResult.local_existing.rollout_path}
					                                >
					                                  {inspectResult.local_existing.rollout_path}
				                                </span>
				                              </div>
				                              {localExistingPreviewError ? (
				                                <div className="error">
				                                  预览失败：{localExistingPreviewError}
				                                </div>
				                              ) : null}
				                              {localExistingPreview ? (
				                                <RolloutPreviewView
				                                  preview={localExistingPreview}
				                                  renderMarkdown={previewRenderMarkdown}
				                                />
				                              ) : localExistingPreviewBusy ? (
				                                <div className="muted">预览加载中...</div>
				                              ) : (
				                                <div className="muted small">
				                                  自动预览最近 {previewMaxMessages} 条消息。
				                                </div>
				                              )}
				                            </>
				                          ) : (
				                            <div className="muted small">
				                              已折叠：不会加载预览内容（点击“展开”加载）。
				                            </div>
				                          )}
				                        </>
				                      ) : (
				                        <div className="muted">未找到本机版本。</div>
				                      )}
			                    </div>
			                  </div>

			                  <div className="hint muted">
			                    检测到同会话ID但内容不同：默认推荐
			                    <span className="mono"> 改ID导入</span>
			                    ，以保留分叉（两条都可 resume）。
			                  </div>
			                </>
				              ) : (
				                <>
				                  <div className="row sectionHeader">
				                    <h3 className="grow">预览（导入包，最近消息）</h3>
				                    <button
				                      type="button"
				                      onClick={() => setBundlePreviewOpen((v) => !v)}
				                    >
				                      {bundlePreviewOpen ? "折叠预览" : "展开预览"}
				                    </button>
				                  </div>
				                  {bundlePreviewOpen ? (
				                    <>
					                      <div className="row">
					                        <button
					                          type="button"
					                          disabled={bundlePreviewBusy}
					                          onClick={() =>
					                            loadBundlePreview(inspectResult.bundle_path)
					                          }
					                        >
					                          {bundlePreviewBusy ? "预览中..." : "刷新预览"}
					                        </button>
					                        <button
					                          type="button"
					                          disabled={
					                            bundlePreviewBusy ||
					                            previewMaxMessages >= PREVIEW_MAX_MESSAGES_CAP
					                          }
					                          onClick={() =>
					                            setPreviewMaxMessages((v) =>
					                              Math.min(
					                                PREVIEW_MAX_MESSAGES_CAP,
					                                v + PREVIEW_LOAD_MORE_STEP,
					                              ),
					                            )
					                          }
					                        >
					                          加载更多（+{PREVIEW_LOAD_MORE_STEP}）
					                        </button>
					                        <button
					                          type="button"
					                          disabled={
					                            bundlePreviewBusy ||
					                            previewMaxMessages === PREVIEW_MAX_MESSAGES_DEFAULT
					                          }
					                          onClick={() =>
					                            setPreviewMaxMessages(PREVIEW_MAX_MESSAGES_DEFAULT)
					                          }
					                        >
					                          重置
					                        </button>
					                        <span className="muted small">
					                          当前显示最近 {previewMaxMessages} 条
					                        </span>
					                        <span className="hint muted">
					                          提示：zip 预览需要扫描整个文件，较大的会话可能会比较慢。
					                        </span>
					                      </div>
				                      {bundlePreviewError ? (
				                        <div className="error">
				                          预览失败：{bundlePreviewError}
				                        </div>
				                      ) : null}
				                      {bundlePreview ? (
				                        <RolloutPreviewView
				                          preview={bundlePreview}
				                          renderMarkdown={previewRenderMarkdown}
				                        />
				                      ) : bundlePreviewBusy ? (
				                        <div className="muted">预览加载中...</div>
				                      ) : (
				                        <div className="muted small">
				                          自动预览最近 {previewMaxMessages} 条消息。
				                        </div>
				                      )}
				                    </>
				                  ) : (
				                    <div className="muted small">
				                      已折叠：不会加载预览内容（点击“展开”加载）。
				                    </div>
				                  )}
				                </>
				              )}

		              <div className="hint muted small">
		                （已完成检查）导入选项在下方设置。
		              </div>
	            </div>
	          ) : null}

            {inspectBatchResult ? (
              <div className="result">
                <h3>合并导出包信息</h3>
                <div className="kv">
                  <div>类型</div>
                  <div className="mono small">{inspectBatchResult.kind}</div>
                  <div>名称</div>
                  <div>{inspectBatchResult.name ?? "-"}</div>
                  <div>备注</div>
                  <div>{inspectBatchResult.note ?? "-"}</div>
                  <div>创建时间</div>
                  <div>{formatRfc3339(inspectBatchResult.created_at)}</div>
                  <div>包含会话</div>
                  <div>{inspectBatchResult.items.length}</div>
                  <div>警告</div>
                  <div>
                    {inspectBatchResult.warnings.length ? (
                      <span className="mono small">
                        {inspectBatchResult.warnings.join(" / ")}
                      </span>
                    ) : (
                      <span className="muted">-</span>
                    )}
                  </div>
                </div>

                <h3>会话列表</h3>
                <div className="tableWrap">
                  <table className="table compact">
                    <thead>
                      <tr>
                        <th>会话ID</th>
                        <th>名称</th>
                        <th>时间</th>
                        <th>SHA</th>
                        <th>大小</th>
                        <th>条目</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inspectBatchResult.items.map((it, idx) => (
                        <tr key={`${it.inner_zip}-${idx}`}>
                          <td className="mono small nowrap" title={it.session_id ?? ""}>
                            {it.session_id ?? "-"}
                          </td>
                          <td className="truncate" title={it.name ?? ""}>
                            {it.name ?? "-"}
                          </td>
                          <td className="nowrap">{formatRfc3339(it.created_at)}</td>
                          <td className="mono small nowrap" title={it.rollout_sha256 ?? ""}>
                            {shortSha(it.rollout_sha256)}
                          </td>
                          <td className="nowrap">{formatBytes(it.rollout_size)}</td>
                          <td className="mono small truncatePath" title={it.inner_zip}>
                            {it.inner_zip}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="row sectionHeader">
                  <h3 className="grow">预览（合并包内单会话，最近消息）</h3>
                  <button
                    type="button"
                    onClick={() => setBatchEntryPreviewOpen((v) => !v)}
                  >
                    {batchEntryPreviewOpen ? "折叠预览" : "展开预览"}
                  </button>
                </div>
                {batchEntryPreviewOpen ? (
                  <>
                    <div className="row">
                      <label className="field" style={{ flex: "1 1 420px" }}>
                        <div className="label">选择会话</div>
                        <select
                          value={batchEntryName}
                          onChange={(e) => setBatchEntryName(e.target.value)}
                        >
                          {inspectBatchResult.items.map((it, idx) => {
                            const label = it.session_id
                              ? `${it.session_id}${it.name ? ` • ${it.name}` : ""}`
                              : it.inner_zip;
                            return (
                              <option key={`${it.inner_zip}-${idx}`} value={it.inner_zip}>
                                {label}
                              </option>
                            );
                          })}
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={batchEntryPreviewBusy || !batchEntryName}
                        onClick={() =>
                          loadBatchEntryPreview(
                            inspectBatchResult.bundle_path,
                            batchEntryName,
                          )
                        }
                      >
                        {batchEntryPreviewBusy ? "预览中..." : "刷新预览"}
                      </button>
                      <button
                        type="button"
                        disabled={
                          batchEntryPreviewBusy ||
                          previewMaxMessages >= PREVIEW_MAX_MESSAGES_CAP
                        }
                        onClick={() =>
                          setPreviewMaxMessages((v) =>
                            Math.min(
                              PREVIEW_MAX_MESSAGES_CAP,
                              v + PREVIEW_LOAD_MORE_STEP,
                            ),
                          )
                        }
                      >
                        加载更多（+{PREVIEW_LOAD_MORE_STEP}）
                      </button>
                      <button
                        type="button"
                        disabled={
                          batchEntryPreviewBusy ||
                          previewMaxMessages === PREVIEW_MAX_MESSAGES_DEFAULT
                        }
                        onClick={() => setPreviewMaxMessages(PREVIEW_MAX_MESSAGES_DEFAULT)}
                      >
                        重置
                      </button>
                      <span className="muted small">
                        当前显示最近 {previewMaxMessages} 条
                      </span>
                    </div>
                    {batchEntryPreviewError ? (
                      <div className="error">预览失败：{batchEntryPreviewError}</div>
                    ) : null}
                    {batchEntryPreview ? (
                      <RolloutPreviewView
                        preview={batchEntryPreview}
                        renderMarkdown={previewRenderMarkdown}
                      />
                    ) : batchEntryPreviewBusy ? (
                      <div className="muted">预览加载中...</div>
                    ) : (
                      <div className="muted small">
                        自动预览最近 {previewMaxMessages} 条消息。
                      </div>
                    )}
                  </>
                ) : (
                  <div className="muted small">
                    已折叠：不会加载预览内容（点击“展开”加载）。
                  </div>
                )}

                <div className="hint muted small">
                  （已完成检查）导入选项在下方设置。
                </div>
              </div>
            ) : null}

	          {importBundlePaths.length ? (
	            <div className="result">
	              <h3>导入选项</h3>
	              <div className="grid">
	                <label className="field">
	                  <div className="label">名称（必填）</div>
	                  <input
	                    value={importName}
	                    onChange={(e) => setImportName(e.target.value)}
	                  />
	                  <div className="hint muted small">
	                    批量导入时会自动在名称后追加短ID（便于历史记录区分）。
	                  </div>
	                </label>
	                <label className="field">
	                  <div className="label">备注</div>
	                  <input
	                    value={importNote}
	                    onChange={(e) => setImportNote(e.target.value)}
	                  />
	                </label>
	                {inspectHasConflict ? (
	                  <div className="field">
	                    <div className="label">处理方式</div>
	                    <div className="radioGroup">
	                      <label className="radio">
	                        <input
	                          type="radio"
	                          name="import_strategy"
	                          checked={importStrategy === "import_as_new"}
	                          onChange={() => setImportStrategy("import_as_new")}
	                        />
	                        <span>改ID导入（推荐，保留分叉）</span>
	                      </label>
	                      <label className="radio">
	                        <input
	                          type="radio"
	                          name="import_strategy"
	                          checked={importStrategy === "overwrite"}
	                          onChange={() => setImportStrategy("overwrite")}
	                        />
	                        <span>覆盖本机（会自动备份本机版本到存档库）</span>
	                      </label>
	                      <label className="radio">
	                        <input
	                          type="radio"
	                          name="import_strategy"
	                          checked={importStrategy === "cancel"}
	                          onChange={() => setImportStrategy("cancel")}
	                        />
	                        <span>取消（仅存档，不写入 CODEX_HOME）</span>
	                      </label>
	                    </div>
	                  </div>
	                ) : (
	                  <label className="field">
	                    <div className="label">导入方式</div>
	                    <select
	                      value={importStrategy}
	                      onChange={(e) =>
	                        setImportStrategy(e.target.value as ConflictStrategy)
	                      }
	                    >
	                      <option value="recommended">推荐（有冲突则改ID）</option>
	                      <option value="overwrite">覆盖本机 / 写入原位置</option>
	                      <option value="import_as_new">改ID导入（新会话）</option>
	                      <option value="cancel">取消</option>
	                    </select>
	                    <div className="hint muted">
	                      默认：<span className="mono">覆盖本机</span>
	                    </div>
	                  </label>
	                )}
	                <div className="field">
	                  <div className="label">路径重绑（跨设备可选）</div>
	                  <div className="hint muted small">
	                    两台机器项目路径不一致时，把 A 机旧路径前缀替换为 B 机新路径。
	                    留空则不改动。
	                  </div>
	                  {importPathRewrites.map((rw, i) => (
	                    <div
	                      key={i}
	                      style={{
	                        display: "flex",
	                        gap: 6,
	                        marginTop: 6,
	                        flexWrap: "wrap",
	                        alignItems: "center",
	                      }}
	                    >
	                      <input
	                        style={{ flex: "1 1 200px" }}
	                        placeholder="A 机旧路径，如 C:\Users\alex\proj"
	                        value={rw.from}
	                        onChange={(e) => updatePathRewrite(i, "from", e.target.value)}
	                      />
	                      <span className="muted">→</span>
	                      <input
	                        style={{ flex: "1 1 200px" }}
	                        placeholder="B 机新路径"
	                        value={rw.to}
	                        onChange={(e) => updatePathRewrite(i, "to", e.target.value)}
	                      />
	                      <button
	                        type="button"
	                        onClick={() => pickRewriteTarget(i)}
	                      >
	                        选文件夹
	                      </button>
	                      <button type="button" onClick={() => removePathRewrite(i)}>
	                        删除
	                      </button>
	                    </div>
	                  ))}
	                  <button
	                    type="button"
	                    style={{ marginTop: 6 }}
	                    onClick={addPathRewrite}
	                  >
	                    + 添加一条路径映射
	                  </button>
	                </div>
	              </div>
	              <div className="row">
	                <button
	                  type="button"
	                  disabled={!isTauri || busy || !importName.trim()}
	                  onClick={handleImport}
	                >
	                  {busyAction === "import" ? "导入中..." : "导入"}
	                </button>
	              </div>
	            </div>
	          ) : null}

	          {importBatchResult ? (
	            <div className="result">
	              <h3>导入结果</h3>
	              <div className="kv">
	                <div>选择的 zip</div>
	                <div>{importBatchResult.requested_paths}</div>
	                <div>导入成功</div>
	                <div>{importBatchResult.imported}</div>
	                <div>导入失败</div>
	                <div>{importBatchResult.failed}</div>
	              </div>
	              {importBatchResult.errors.length ? (
	                <div className="error">
	                  <div>以下条目导入失败：</div>
	                  <pre className="mono small">
	                    {importBatchResult.errors
	                      .map((e) => `${e.source}: ${e.message}`)
	                      .join("\n")}
	                  </pre>
	                </div>
	              ) : null}
	              {importBatchResult.items.map((it, idx) => (
	                <div
	                  className="resultBlock"
	                  key={`${it.result.transfer_id}-${idx}`}
	                >
	                  <div className="kv">
	                    <div>来源</div>
	                    <div className="mono small truncatePath" title={it.source}>
	                      {it.source}
	                    </div>
	                    <div>状态</div>
	                    <div>
	                      <span className="pill">
	                        {statusZh(it.result.status)}
	                      </span>
	                    </div>
	                    <div>实际会话ID</div>
	                    <div className="mono">{it.result.effective_session_id}</div>
	                    <div>恢复命令</div>
	                    <div className="mono">{it.result.resume_cmd ?? "-"}</div>
	                    <div>会话列表</div>
	                    <div>
	                      {it.result.indexed === false
	                        ? "未登记（会话已存在或被取消）"
	                        : "已登记到 session_index，重启 Codex 后在列表可见"}
	                    </div>
	                    {it.result.shell_snapshot_present ? (
	                      <>
	                        <div>Shell 快照</div>
	                        <div className="hint small">
	                          随包携带，已存档到 vault；出于安全未写回（可能含 A 机环境变量）。
	                        </div>
	                      </>
	                    ) : null}
	                    <div>本机文件</div>
	                    <div className="mono">
	                      {it.result.local_rollout_path ?? "-"}
	                    </div>
	                    <div>存档库</div>
	                    <div className="mono">{it.result.vault_dir}</div>
	                  </div>
	                  <div className="row">
	                    {it.result.local_rollout_path ? (
	                      <button
	                        type="button"
	                        onClick={() =>
	                          handleReveal(it.result.local_rollout_path!)
	                        }
	                      >
	                        显示本机文件
	                      </button>
	                    ) : null}
	                    {it.result.resume_cmd ? (
	                      <button
	                        type="button"
	                        onClick={() => handleCopy(it.result.resume_cmd!)}
	                      >
	                        复制恢复命令
	                      </button>
	                    ) : null}
	                    <button
	                      type="button"
	                      onClick={() => handleOpen(it.result.vault_dir)}
	                    >
	                      打开存档库
	                    </button>
	                  </div>
	                </div>
	              ))}
	            </div>
	          ) : null}
	        </section>
	      ) : null}

      {tab === "change_id" ? (
        <section className="panel">
          <h2>更换会话ID</h2>
          <div className="grid">
            <label className="field">
              <div className="label">会话ID</div>
              <input
                value={changeIdSessionId}
                onChange={(e) => setChangeIdSessionId(e.target.value)}
              />
            </label>
            <label className="field">
              <div className="label">名称（必填）</div>
              <input
                value={changeIdName}
                onChange={(e) => setChangeIdName(e.target.value)}
                placeholder="例如：为 Windows 测试创建分叉"
              />
            </label>
            <label className="field">
              <div className="label">备注</div>
              <input
                value={changeIdNote}
                onChange={(e) => setChangeIdNote(e.target.value)}
              />
            </label>
            <label className="field">
              <div className="label">新会话ID（可选）</div>
              <input
                value={changeIdNewId}
                onChange={(e) => setChangeIdNewId(e.target.value)}
                placeholder="留空则自动生成 UUID v7"
              />
            </label>
          </div>
          <div className="row">
            <button
              type="button"
              disabled={
                !isTauri || busy || !changeIdSessionId.trim() || !changeIdName.trim()
              }
              onClick={handleChangeId}
            >
              {busyAction === "change_id" ? "处理中..." : "更换会话ID"}
            </button>
          </div>

          {changeIdResult ? (
            <div className="result">
              <h3>结果</h3>
		              <div className="kv">
		                <div>原会话ID</div>
		                <div className="mono">{changeIdResult.old_session_id}</div>
		                <div>新会话ID</div>
		                <div className="mono">{changeIdResult.new_session_id}</div>
		                <div>恢复命令</div>
		                <div className="mono">{changeIdResult.resume_cmd}</div>
		                <div>本机文件</div>
		                <div className="mono">{changeIdResult.local_rollout_path}</div>
		                <div>存档库</div>
		                <div className="mono">{changeIdResult.vault_dir}</div>
		                <div>导出包</div>
		                <div className="mono">{changeIdResult.bundle_path}</div>
		              </div>
		              <div className="row">
		                <button
		                  type="button"
		                  onClick={() => handleReveal(changeIdResult.local_rollout_path)}
		                >
		                  显示本机文件
		                </button>
		                <button
		                  type="button"
		                  onClick={() => handleReveal(changeIdResult.bundle_path)}
		                >
		                  显示导出包
		                </button>
		                <button
		                  type="button"
		                  onClick={() => handleCopy(changeIdResult.resume_cmd)}
		                >
		                  复制恢复命令
                </button>
                <button
                  type="button"
                  onClick={() => handleOpen(changeIdResult.vault_dir)}
                >
                  打开存档库
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

		      {tab === "history" ? (
		        <section className="panel">
				          <div className="panelHeader">
				            <h2>历史</h2>
				            <div className="row">
				              <button type="button" disabled={busy} onClick={refreshHistory}>
				                {busyAction === "history" ? "加载中..." : "刷新"}
				              </button>
                      <button
                        type="button"
                        disabled={!isTauri || busy || historySelectedIds.size === 0}
                        onClick={handleHistoryDeleteSelected}
                      >
                        {busyAction === "delete_many"
                          ? "删除中..."
                          : `删除选中（${historySelectedIds.size}）`}
                      </button>
				              <button
				                type="button"
		                        className="sideToggleBtn"
                        data-open={historyDetailOpen ? "1" : "0"}
				                title={historyDetailOpen ? "折叠右侧面板" : "展开右侧面板"}
	                        aria-label={historyDetailOpen ? "折叠右侧面板" : "展开右侧面板"}
				                onClick={() => {
				                  const next = !historyDetailOpen;
				                  setHistoryDetailOpen(next);
				                  if (!next) {
				                    setHistoryPreview(null);
				                    setHistoryPreviewError(null);
				                  }
				                }}
				              >
				                <span className="sideChevron" aria-hidden="true" />
				              </button>
				              <input
				                value={historyFilter}
				                onChange={(e) => setHistoryFilter(e.target.value)}
				                placeholder="搜索历史..."
			                className="grow"
			              />
			              <label className="field checkbox">
			                <input
			                  type="checkbox"
			                  checked={historyFavoritesOnly}
			                  onChange={(e) => setHistoryFavoritesOnly(e.target.checked)}
			                />
			                <span title="提示：点击列表中的 ☆ 可收藏。">仅看收藏</span>
			              </label>
			              <select
			                value={historyOpFilter}
			                onChange={(e) => setHistoryOpFilter(e.target.value)}
			              >
			                <option value="all">全部操作</option>
			                <option value="export">导出</option>
			                <option value="import">导入</option>
			                <option value="restore">恢复</option>
			                <option value="change_id">改ID</option>
			              </select>
			              <span className="muted small">
			                {filteredHistory.length}/{history.length}
			              </span>
			            </div>
			          </div>

		          {history.length === 0 ? (
		            <div className="muted">
		              {busyAction === "history" ? "加载中..." : "暂无历史记录。"}
		            </div>
			          ) : (
			            <div className={historyDetailOpen ? "split" : "split splitCollapsed"}>
			              <div className="splitList">
		                {filteredHistory.length === 0 ? (
		                  <div className="muted">没有匹配记录。</div>
		                ) : (
		                  <div className="tableWrap">
			                    <table className="table compact clickable">
				                  <thead>
				                    <tr>
                              <th className="nowrap">
                                <input
                                  ref={selectAllHistoryRef}
                                  type="checkbox"
                                  checked={filteredHistorySelection.all}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    setHistorySelectedIds((prev) => {
                                      const next = new Set(prev);
                                      for (const r of filteredHistory) {
                                        if (checked) next.add(r.id);
                                        else next.delete(r.id);
                                      }
                                      return next;
                                    });
                                  }}
                                />
                              </th>
				                      <th className="nowrap" title="收藏（点击 ☆ / ★ 切换）">
                                收藏
                              </th>
				                      <th>时间</th>
				                      <th>操作</th>
				                      <th>名称</th>
				                      <th>标签</th>
			                      <th>会话</th>
		                      <th>状态</th>
			                    </tr>
			                  </thead>
		                  <tbody>
			                    {filteredHistory.map((r) => {
                              const checked = historySelectedIds.has(r.id);
                              return (
		                      <tr
		                        key={r.id}
		                        className={r.id === historySelectedId ? "selectedRow" : undefined}
			                        onClick={() => {
		                          setHistorySelectedId(r.id);
		                          setRestoreName(`恢复：${r.name}`);
		                          setRestoreNote("");
		                          setRestoreStrategy("recommended");
			                          setRestoreResult(null);
			                        }}
				                      >
                              <td className="nowrap">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => {
                                    const nextChecked = e.target.checked;
                                    setHistorySelectedIds((prev) => {
                                      const next = new Set(prev);
                                      if (nextChecked) next.add(r.id);
                                      else next.delete(r.id);
                                      return next;
                                    });
                                  }}
                                />
                              </td>
		                        <td className="nowrap">
                              <button
                                type="button"
                                className={r.favorite ? "starBtn active" : "starBtn"}
                                title={r.favorite ? "取消收藏" : "收藏"}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleToggleHistoryFavorite(r);
                                }}
                              >
                                {r.favorite ? "★" : "☆"}
                              </button>
                            </td>
		                        <td className="nowrap">{formatRfc3339(r.created_at)}</td>
		                        <td className="nowrap">{opZh(r.op)}</td>
	                        <td className="truncate" title={r.name}>
	                          {r.name}
	                        </td>
	                        <td className="truncate small" title={r.tags ?? ""}>
	                          {r.tags ?? "-"}
	                        </td>
	                        {(() => {
	                          const sid =
	                            r.effective_session_id ??
	                            r.session_id_new ??
	                            r.session_id_old ??
	                            "-";
	                          return (
	                            <td className="mono small nowrap" title={sid}>
	                              {sid}
	                            </td>
	                          );
	                        })()}
	                        <td className="nowrap">
		                          <span className="pill">{statusZh(r.status)}</span>
		                        </td>
			                      </tr>
			                    );
                            })}
			                  </tbody>
		                </table>
		                  </div>
		                )}
			              </div>

		              {historyDetailOpen ? (
		              <div className="splitDetail">
		                {selectedHistory ? (
		                  <>
                        <div className="detailTabs">
                          <button
                            type="button"
                            className={historyDetailTab === "detail" ? "subTab active" : "subTab"}
                            onClick={() => setHistoryDetailTab("detail")}
                          >
                            详情
                          </button>
                          <button
                            type="button"
                            className={
                              historyDetailTab === "preview" ? "subTab active" : "subTab"
                            }
                            onClick={() => setHistoryDetailTab("preview")}
                          >
                            预览
                          </button>
                        </div>

                        {historyDetailTab === "detail" ? (
                          <>
                            <div className="kv">
                              <div>记录ID</div>
                              <div className="mono">{selectedHistory.id}</div>
                              <div>创建时间</div>
                              <div>{formatRfc3339(selectedHistory.created_at)}</div>
                              <div>最后编辑</div>
                              <div>{formatRfc3339(selectedHistory.updated_at)}</div>
                              <div>操作</div>
                              <div>{opZh(selectedHistory.op)}</div>
                              <div>状态</div>
                              <div>
                                <span className="pill">
                                  {statusZh(selectedHistory.status)}
                                </span>
                              </div>
                              <div>名称</div>
                              <div>{selectedHistory.name}</div>
                              <div>备注</div>
                              <div>{selectedHistory.note ?? "-"}</div>
                              <div>标签</div>
                              <div>{selectedHistory.tags ?? "-"}</div>
                              <div>收藏</div>
                              <div className="mono small">
                                {selectedHistory.favorite ? "★" : "-"}
                              </div>
                              <div>会话ID</div>
                              <div className="mono">
                                {selectedHistory.effective_session_id ??
                                  selectedHistory.session_id_new ??
                                  selectedHistory.session_id_old ??
                                  "-"}
                              </div>
                              <div>SHA256</div>
                              <ExpandableMono value={selectedHistory.rollout_sha256} />
                              <div>存档库</div>
                              <ExpandableMono value={selectedHistory.vault_dir} />
                              <div>导出包</div>
                              <ExpandableMono value={selectedHistory.bundle_path || null} />
                              <div>本机文件</div>
                              <ExpandableMono value={selectedHistory.local_rollout_path} />
                            </div>

                            <div className="row">
                              <button
                                type="button"
                                disabled={!isTauri}
                                onClick={() => handleOpen(selectedHistory.vault_dir)}
                              >
                                打开存档库
                              </button>
                              {selectedHistory.bundle_path ? (
                                <button
                                  type="button"
                                  disabled={!isTauri}
                                  onClick={() => handleReveal(selectedHistory.bundle_path)}
                                >
                                  显示导出包
                                </button>
                              ) : null}
                              {selectedHistory.effective_session_id ||
                              selectedHistory.session_id_new ||
                              selectedHistory.session_id_old ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleCopy(
                                      `codex resume ${
                                        selectedHistory.effective_session_id ??
                                        selectedHistory.session_id_new ??
                                        selectedHistory.session_id_old
                                      }`,
                                    )
                                  }
                                >
                                  复制恢复命令
                                </button>
                              ) : null}
                              {selectedHistory.local_rollout_path ? (
                                <button
                                  type="button"
                                  disabled={!isTauri}
                                  onClick={() =>
                                    handleReveal(selectedHistory.local_rollout_path!)
                                  }
                                >
                                  显示本机文件
                                </button>
                              ) : null}
                            </div>

                            <h3>编辑元信息</h3>
                            <div className="grid">
                              <label className="field">
                                <div className="label">名称（必填）</div>
                                <input
                                  value={historyEditName}
                                  onChange={(e) => setHistoryEditName(e.target.value)}
                                />
                              </label>
                              <label className="field">
                                <div className="label">备注</div>
                                <input
                                  value={historyEditNote}
                                  onChange={(e) => setHistoryEditNote(e.target.value)}
                                />
                              </label>
                              <label className="field">
                                <div className="label">标签（用逗号分隔）</div>
                                <input
                                  value={historyEditTags}
                                  onChange={(e) => setHistoryEditTags(e.target.value)}
                                  placeholder="例如：mac, win, bugfix"
                                />
                              </label>
                              <label className="field checkbox">
                                <input
                                  type="checkbox"
                                  checked={historyEditFavorite}
                                  onChange={(e) => setHistoryEditFavorite(e.target.checked)}
                                />
                                <span>收藏</span>
                              </label>
                            </div>
                            <div className="row">
                              <button
                                type="button"
                                disabled={
                                  !isTauri || historyEditBusy || !historyEditName.trim()
                                }
                                onClick={() => handleHistorySaveMeta(selectedHistory.id)}
                              >
                                {historyEditBusy ? "保存中..." : "保存"}
                              </button>
                              <button
                                type="button"
                                disabled={historyEditBusy}
                                onClick={resetHistoryEditFields}
                              >
                                重置
                              </button>
                            </div>
                            {historyEditError ? (
                              <div className="error">保存失败：{historyEditError}</div>
                            ) : null}

                            <h3>恢复</h3>
                            <div className="grid">
                              <label className="field">
                                <div className="label">名称（必填）</div>
                                <input
                                  value={restoreName}
                                  onChange={(e) => setRestoreName(e.target.value)}
                                />
                              </label>
                              <label className="field">
                                <div className="label">备注</div>
                                <input
                                  value={restoreNote}
                                  onChange={(e) => setRestoreNote(e.target.value)}
                                />
                              </label>
                              <label className="field">
                                <div className="label">冲突策略</div>
                                <select
                                  value={restoreStrategy}
                                  onChange={(e) =>
                                    setRestoreStrategy(e.target.value as ConflictStrategy)
                                  }
                                >
                                  <option value="recommended">推荐</option>
                                  <option value="import_as_new">改ID导入（新会话）</option>
                                  <option value="overwrite">覆盖本机</option>
                                  <option value="cancel">取消</option>
                                </select>
                              </label>
                            </div>
                            <div className="row">
                              <button
                                type="button"
                                disabled={!isTauri || busy || !restoreName.trim()}
                                onClick={() => handleRestoreFromHistory(selectedHistory.id)}
                              >
                                {busyAction === "restore" ? "恢复中..." : "恢复"}
                              </button>
                            </div>

                            {restoreResult ? (
                              <div className="result">
                                <h3>恢复结果</h3>
                                <div className="kv">
                                  <div>状态</div>
                                  <div>
                                    <span className="pill">
                                      {statusZh(restoreResult.status)}
                                    </span>
                                  </div>
                                  <div>实际会话ID</div>
                                  <div className="mono">{restoreResult.effective_session_id}</div>
                                  <div>恢复命令</div>
                                  <div className="mono">{restoreResult.resume_cmd ?? "-"}</div>
                                  <div>本机文件</div>
                                  <div className="mono">{restoreResult.local_rollout_path ?? "-"}</div>
                                </div>
                                {restoreResult.resume_cmd ? (
                                  <div className="row">
                                    <button
                                      type="button"
                                      onClick={() => handleCopy(restoreResult.resume_cmd!)}
                                    >
                                      复制恢复命令
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}

                            <h3>删除</h3>
                            <label className="field checkbox">
                              <input
                                type="checkbox"
                                checked={historyDeleteFiles}
                                disabled={!isTauri}
                                onChange={(e) => setHistoryDeleteFiles(e.target.checked)}
                              />
                              <span>同时删除存档库文件</span>
                            </label>
                            <div className="row">
                              <button
                                type="button"
                                disabled={!isTauri || busy}
                                onClick={() => handleHistoryDelete(selectedHistory.id)}
                              >
                                {busyAction === "delete" ? "删除中..." : "删除记录"}
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="row sectionHeader">
                              <h3 className="grow">预览（存档库版本，最近消息）</h3>
                            </div>
                            <div className="row">
                              <button
                                type="button"
                                disabled={historyPreviewBusy}
                                onClick={() => loadHistoryPreview(selectedHistory)}
                              >
                                {historyPreviewBusy ? "预览中..." : "刷新预览"}
                              </button>
                              <button
                                type="button"
                                disabled={
                                  historyPreviewBusy ||
                                  previewMaxMessages >= PREVIEW_MAX_MESSAGES_CAP
                                }
                                onClick={() =>
                                  setPreviewMaxMessages((v) =>
                                    Math.min(
                                      PREVIEW_MAX_MESSAGES_CAP,
                                      v + PREVIEW_LOAD_MORE_STEP,
                                    ),
                                  )
                                }
                              >
                                加载更多（+{PREVIEW_LOAD_MORE_STEP}）
                              </button>
                              <button
                                type="button"
                                disabled={
                                  historyPreviewBusy ||
                                  previewMaxMessages === PREVIEW_MAX_MESSAGES_DEFAULT
                                }
                                onClick={() =>
                                  setPreviewMaxMessages(PREVIEW_MAX_MESSAGES_DEFAULT)
                                }
                              >
                                重置
                              </button>
                              <span className="muted small">
                                当前显示最近 {previewMaxMessages} 条
                              </span>
                              <span className="muted small">
                                优先预览存档库中的会话文件（rollout），其次 bundle.zip，最后回退到本机文件。
                              </span>
                            </div>
                            {historyPreviewError ? (
                              <div className="error">预览失败：{historyPreviewError}</div>
                            ) : null}
                            {historyPreview ? (
                              <RolloutPreviewView
                                preview={historyPreview}
                                renderMarkdown={previewRenderMarkdown}
                              />
                            ) : historyPreviewBusy ? (
                              <div className="muted">预览加载中...</div>
                            ) : (
                              <div className="muted small">
                                自动预览最近 {previewMaxMessages} 条消息。
                              </div>
                            )}
                          </>
                        )}
	                  </>
	                ) : (
	                  <div className="muted">请选择一条记录。</div>
		                )}
	              </div>
	              ) : null}
	            </div>
	          )}
	        </section>
      ) : null}

      {tab === "settings" ? (
        <section className="panel">
          <h2>设置</h2>

          <h3>CODEX_HOME</h3>
          {status ? (
            <div className="kv">
              <div>检测到</div>
              <div className="mono">{status.codex_home.detected_home}</div>
              <div>覆盖值</div>
              <div className="mono">{status.codex_home.override_home ?? "-"}</div>
              <div>实际生效</div>
              <div className="mono">{status.codex_home.effective_home}</div>
              <div>来源</div>
              <div>
                <span className="pill">
                  {codexHomeSourceLabel(status.codex_home.source)}
                </span>
              </div>
            </div>
          ) : (
            <div className="muted">加载中...</div>
          )}

          <div className="grid">
            <label className="field">
              <div className="label">覆盖 CODEX_HOME</div>
              <input
                value={codexHomeOverrideInput}
                onChange={(e) => setCodexHomeOverrideInput(e.target.value)}
                placeholder="留空后点击“应用”即可清除覆盖值"
                disabled={!isTauri}
              />
              <div className="hint muted">
                提示：当你需要指向 WSL 或自定义 Codex 数据目录时可用。
              </div>
            </label>
          </div>
          <div className="row">
            <button
              type="button"
              onClick={handleBrowseCodexHomeOverride}
              disabled={!isTauri || busy}
            >
              浏览...
            </button>
            <button
              type="button"
              onClick={handleApplyCodexHomeOverride}
              disabled={!isTauri || busy}
            >
              {busyAction === "settings" ? "应用中..." : "应用"}
            </button>
            <button
              type="button"
              onClick={() => {
                setCodexHomeOverrideInput("");
              }}
              disabled={!isTauri || busy}
            >
              清空（再点“应用”）
            </button>
          </div>

          <h3>设备</h3>
          {status ? (
            <div className="kv">
              <div>设备ID</div>
              <div className="mono">{status.device.device_id}</div>
              <div>系统 / 架构</div>
              <div className="mono">
                {status.device.os} / {status.device.arch}
              </div>
              <div>主机名</div>
              <div className="mono">{status.device.hostname ?? "-"}</div>
            </div>
          ) : null}

          <h3>路径</h3>
          {status ? (
            <>
              <div className="kv">
                <div>应用数据</div>
                <div className="mono">{status.app_data_dir}</div>
                <div>存档库</div>
                <div className="mono">{status.vault_dir}</div>
                <div>DB</div>
                <div className="mono">{status.db_path}</div>
              </div>
              <div className="row">
                <button
                  type="button"
                  disabled={!isTauri}
                  onClick={() => handleOpen(status.codex_home.effective_home)}
                >
                  打开 CODEX_HOME
                </button>
                <button
                  type="button"
                  disabled={!isTauri}
                  onClick={() => handleOpen(status.vault_dir)}
                >
                  打开存档库
                </button>
              </div>
            </>
          ) : null}

          <h3>更新</h3>
          <div className="row">
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={updateAutoCheck}
                onChange={(e) => setUpdateAutoCheck(e.target.checked)}
              />
              <span>启动时自动检查更新（每天最多一次）</span>
            </label>
            <button
              type="button"
              disabled={!isTauri || updateCheckBusy}
              onClick={() => runCheckUpdate(true)}
            >
              {updateCheckBusy ? "检查中..." : "检查更新"}
            </button>
          </div>
          <div className="muted small">
            上次检查：{updateLastCheckedMs ? formatTimeMs(updateLastCheckedMs) : "-"}
          </div>
          {updateCheckError ? (
            <div className="error">检查更新失败：{updateCheckError}</div>
          ) : null}
          {updateCheckResult ? (
            <div className="kv">
              <div>当前版本</div>
              <div className="mono">{updateCheckResult.current_version}</div>
              <div>最新版本</div>
              <div className="mono">
                {updateCheckResult.latest_version}{" "}
                {updateCheckResult.has_update ? (
                  <span className="pill warn">可更新</span>
                ) : (
                  <span className="pill ok">已是最新</span>
                )}
              </div>
              <div>发布日期</div>
              <div>{formatRfc3339(updateCheckResult.published_at)}</div>
              <div>Release</div>
              <div className="mono small">{updateCheckResult.release_url}</div>
            </div>
          ) : (
            <div className="muted">提示：点击“检查更新”以获取最新版本信息。</div>
          )}
          {updateCheckResult ? (
            <div className="row">
              <button
                type="button"
                onClick={() => handleOpenUrl(updateCheckResult.release_url)}
              >
                打开 Release
              </button>
              <button
                type="button"
                onClick={() =>
                  handleCopy(
                    'brew tap star-alp/tap-codexrelay && brew update && (brew upgrade --cask codexrelay || brew install --cask --force codexrelay)',
                  )
                }
              >
                复制 Homebrew 安装/更新命令
              </button>
              <button
                type="button"
                onClick={() =>
                  handleCopy(
                    "sudo xattr -dr com.apple.quarantine /Applications/CodexRelay.app",
                  )
                }
              >
                复制 macOS 放行命令
              </button>
            </div>
          ) : null}
          {updateCheckResult ? (
            <div className="hint muted small">
              提示：如果你之前是手动拖拽 DMG 安装（非 Homebrew），直接运行{" "}
              <span className="mono">brew upgrade</span> 会提示 cask 未安装；上面的命令会在需要时自动安装并覆盖{" "}
              <span className="mono">/Applications/CodexRelay.app</span>（不影响应用数据/存档库）。
            </div>
          ) : null}

          <h3>预览</h3>
          <div className="grid">
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={previewRenderMarkdown}
                onChange={(e) => setPreviewRenderMarkdown(e.target.checked)}
              />
              <span>消息内容使用 Markdown 渲染（可选）</span>
            </label>
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={previewIncludeMeta}
                onChange={(e) => setPreviewIncludeMeta(e.target.checked)}
              />
              <span>包含系统/开发者/工具消息（高级）</span>
            </label>
            <label className="field">
              <div className="label">显示最近消息数</div>
              <input
                value={String(previewMaxMessages)}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  if (!Number.isFinite(n)) return;
                  setPreviewMaxMessages(Math.min(PREVIEW_MAX_MESSAGES_CAP, Math.max(1, n)));
                }}
                placeholder={String(PREVIEW_MAX_MESSAGES_DEFAULT)}
                style={{ width: 180 }}
              />
              <div className="hint muted">范围：1 ~ {PREVIEW_MAX_MESSAGES_CAP}</div>
            </label>
            <label className="field">
              <div className="label">单条消息最大字符数</div>
              <input
                value={String(previewMaxCharsPerMessage)}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  if (!Number.isFinite(n)) return;
                  setPreviewMaxCharsPerMessage(Math.min(20000, Math.max(200, n)));
                }}
                placeholder={String(PREVIEW_MAX_CHARS_PER_MESSAGE_DEFAULT)}
                style={{ width: 180 }}
              />
              <div className="hint muted">范围：200 ~ 20000（过大会影响性能）</div>
            </label>
            <div className="hint muted">
              提示：仅影响预览显示；默认不解析 HTML，适合阅读列表/代码块。
            </div>
          </div>

          <h3>存档库占用</h3>
          <div className="row">
            <button
              type="button"
              onClick={refreshVaultUsage}
              disabled={vaultUsageBusy || busy}
            >
              {vaultUsageBusy ? "统计中..." : "刷新统计"}
            </button>
            <label className="field">
              <div className="label">统计条数</div>
              <input
                value={String(vaultUsageLimit)}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  setVaultUsageLimit(Number.isFinite(n) ? n : 200);
                }}
                placeholder="例如：200"
                style={{ width: 120 }}
              />
            </label>
            <span className="muted small">提示：统计会遍历存档库目录，可能较慢。</span>
          </div>
          {vaultUsageError ? (
            <div className="error">统计失败：{vaultUsageError}</div>
          ) : null}
          {vaultUsage ? (
            <>
              <div className="muted small">
                总计：{formatBytes(vaultUsage.total_bytes)}（{vaultUsage.total_files} 个文件）
                <span className="dot">•</span>
                已统计 {vaultUsage.items.length} 条记录
              </div>
              {vaultUsage.items.length ? (
                <div className="tableWrap">
                  <table className="table compact">
                    <thead>
                      <tr>
                        <th>大小</th>
                        <th>文件数</th>
                        <th>时间</th>
                        <th>操作</th>
                        <th>名称</th>
                        <th>会话</th>
                        <th>状态</th>
                        <th>管理</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...vaultUsage.items]
                        .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
                        .slice(0, 30)
                        .map((it) => (
                          <tr key={it.id}>
                            <td className="nowrap">{formatBytes(it.bytes)}</td>
                            <td className="nowrap">{it.files}</td>
                            <td className="nowrap">{formatRfc3339(it.created_at)}</td>
                            <td className="nowrap">{opZh(it.op)}</td>
                            <td className="truncate" title={it.name}>
                              {it.name}
                            </td>
                            <td
                              className="mono small nowrap"
                              title={it.effective_session_id ?? "-"}
                            >
                              {it.effective_session_id ?? "-"}
                            </td>
                            <td className="nowrap">
                              <span className="pill">{statusZh(it.status)}</span>
                            </td>
                            <td className="nowrap">
                              <button
                                type="button"
                                disabled={!isTauri}
                                onClick={() => handleOpen(it.vault_dir)}
                              >
                                打开
                              </button>
                              <button
                                type="button"
                                onClick={() => jumpToHistoryRecord(it.id, it.name)}
                              >
                                查看记录
                              </button>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="muted">暂无历史记录。</div>
              )}
            </>
          ) : (
            <div className="muted small">点击“刷新统计”以查看占用情况。</div>
          )}
        </section>
      ) : null}

      {dragActive ? (
        <div className="dropOverlay">
          <div className="dropCard">
            <div className="dropTitle">拖拽导入</div>
            <div className="dropHint">松开鼠标以导入 bundle.zip</div>
            {dragPaths.length ? (
              <div className="mono small truncatePath" title={dragPaths.join("\n")}>
                {dragPaths.join("  ")}
              </div>
            ) : (
              <div className="muted small">支持：bundle.zip</div>
            )}
          </div>
        </div>
      ) : null}
    </main>
  );
}

export default App;
