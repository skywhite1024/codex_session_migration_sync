# Paginated history migration

Recent Codex rollouts can be segments rather than complete conversations.
`session_meta.payload.history_base` identifies an ancestor by thread ID, an
exclusive ordinal and a byte offset in its original rollout. A continuation may
refer to an earlier segment with the **same** thread ID. Copying one file, or
rewriting paths before resolving that reference, can produce an unreadable task.

## Export and import behavior

- Export resolves history recursively on the **source** device, including
  `sessions` and `archived_sessions`, and materializes the required prefixes into
  one independent rollout. Later parent messages are excluded.
- Prefixes must end on a JSONL record boundary and match the referenced ordinal.
  Missing, inconsistent, cyclic or ambiguous history is an export error. Do not
  repair a dependency by clamping a byte offset or deleting `history_base`.
- The materialized file uses the selected thread's metadata and consecutive
  ordinals. It preserves message/event payloads and no longer needs the ancestor
  files. Only then may import rewrite paths or assign a new identity. Both `id`
  and `session_id` are updated together.
- Standalone older bundles remain supported (manifest schema 1). Older bundles
  that still contain history dependencies are rejected **before** overwriting a
  local session or adding an index entry. Re-export them from a source device
  containing all original segments. A destination's same-ID parent is not a safe
  substitute for the source's original history.
- A registration failure is persisted as `partial`, with the app-server error;
  it is included in the batch failure count. Files remain available in the vault
  for diagnosis. `excludeTurns` limits a resume response; it does not turn resume
  into a read-only metadata operation.

## Verification

Run `pnpm check`. Regression tests cover archived ancestors, same-ID
continuations, exclusion of later parent messages, Unicode, missing/truncated or
ambiguous ancestors, ID synchronization, export/import with path rebinding,
rejection before overwrite, and persistent registration errors.

For an offline diagnostic, without changing the source CODEX_HOME:

```text
cargo run --manifest-path src-tauri/Cargo.toml --example materialize_history -- HOME INPUT OUTPUT
```

Optional arguments `FROM TO NEW_ID` also exercise path and identity rewriting.
The output path must not already exist. Use an isolated CODEX_HOME to validate
outputs with the installed Codex `thread/resume` and `thread/turns/list` APIs;
do not use a production catalog for test imports.

The ignored `app_server::tests::register_isolated_fixture` test exercises the
actual registration code. Set `CODEXRELAY_TEST_HOME` to an isolated directory
containing `migration-test-fixture.json` (an array of test thread IDs), then run
`cargo test --manifest-path src-tauri/Cargo.toml --lib register_isolated_fixture -- --ignored --nocapture`.
It also checks that one missing thread does not prevent subsequent registration.

An incomplete old archive cannot recreate missing message content. Restore the
missing source segments before exporting it again.

## Thread names

Export and the session picker prefer an explicit Desktop catalog `name`, then
the latest valid `session_index.jsonl` name, then the catalog's fallback `title`.
The fallback can be a first message; it must not override an explicit name.
Restoring from the vault preserves the matching original/effective manifest's
thread title instead of substituting the transfer label. Index updates append a
new entry so old duplicate rows cannot undo a rename and existing bytes are not
replaced while Codex is running.

## Import directories

Selecting import archives now reads each manifest's source cwd, including nested
batch archives, without extracting or registering conversations. Existing local
projects are read from the Desktop project catalog, session cwd values, trust
config and saved workspace roots. Only existing local directories are offered.
An exact path or a unique matching final directory name is prefilled; ambiguous
or renamed projects require choosing a candidate or browsing a folder. The user
can inspect and edit every mapping before import. No fuzzy match is silently
applied. Detection errors leave manual mapping available.

Read-only verification: `cargo run --manifest-path src-tauri/Cargo.toml --example
detect_import_paths -- HOME BUNDLE [BUNDLE...]`.
