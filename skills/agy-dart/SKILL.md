---
name: agy-dart
description: >-
  Workflow playbook for agy-dart dual-engine acceleration, transparent CLI filtering,
  KV-cache diagnostics, read deduplication, and SQLite FTS5 context protection.
---

# agy-dart Playbook

`agy-dart` unites two zero-dependency engines plus five lifecycle hooks inside one Antigravity plugin:
1. **`agy-dart_fast`** — batched search/outlines/edits/checks (`<= 8.8 KB` inline).
2. **`agy-dart_context`** — local sandbox filtering & heading-aware SQLite FTS5 (`~/.agy-dart/context.db`).
3. **Lifecycle Guards** — prefix-stable `SessionStart` (with `git HEAD`-cached repo hubs), `PreToolUse` (transparent `overwrite` CLI filtering with 3-stage context-preserving `git diff` + 4-tier read guard: 45 KiB / 800-line source 2-strike, 16 KB noise/minified, 128 KB `.patch`/`.diff` + 2-strike unchanged read dedup + independent 16 KB shell dump guard), `PostToolUse` (edit/compaction dedup invalidation & watchdog heartbeat), `PreInvocation` (zero-prefix-pollution UI-only KV-cache watermark/TTL alerts & watchdog lease), and `Stop` (marks per-conversation watchdog lease `IDLE`).

## 1. Thinking in Code (`ctx_execute`)

For logs, test dumps, CSV/JSON files, or API responses larger than 16 KB, extract only the computed facts in the sandbox (`timeoutSec`: 1–300, default 120s; pass `cwd` when targeting a specific workspace directory; supports both CommonJS `require` and top-level ESM `import`):

- **Keep MCP tool cards compact**: Always put a short `intent` first so the tool card header and FTS5 index carry a clear summary immediately.
- **Short one-liners (`<= 5 lines` / `<= ~400 chars`)**: Pass inline `code`:
  ```json
  {
    "intent": "Count and sample errors from build.log",
    "language": "javascript",
    "code": "const fs = require('fs'); const lines = fs.readFileSync('build.log', 'utf8').split(/\\r?\\n/); const errs = lines.filter(l => /error|exception/i.test(l)); console.log(JSON.stringify({ totalLines: lines.length, errorCount: errs.length, sample: errs.slice(0, 20) }, null, 2));",
    "timeoutSec": 120
  }
  ```
- **Multi-line scripts (`> 5 lines` / `> ~400 chars`)**: In Antigravity (including SSH-Remote WSL and `Non-Workspace File Access: ask | deny`), write the script to the conversation's built-in scratch directory first (`<Artifact Directory Path>/scratch/agy_ctx_trace.py`, i.e. `<appDataDir>/brain/<conversation-id>/scratch/agy_ctx_trace.py`) so `write_file` stays inside the pre-authorized conversation folder without triggering non-workspace permission prompts. On non-Antigravity hosts, write to a concrete absolute OS temp path (e.g. `/tmp/agy_ctx_trace.py` on Linux/macOS or `C:/Users/<user>/AppData/Local/Temp/agy_ctx_trace.py` on Windows — never pass unexpanded `$TEMP/...` to `write_file`, and keep temp scripts outside the repo so `git status` stays clean). Then pass `file` + `args` instead of embedding a large `code` block in MCP arguments:
  ```json
  {
    "intent": "Analyze slow queries in trace.json",
    "language": "python",
    "file": "/home/<user>/.gemini/antigravity/brain/<conversation-id>/scratch/agy_ctx_trace.py",
    "args": ["trace.json"]
  }
  ```
  *(On non-Antigravity hosts without `brain/<conversation-id>/scratch/`, pass `"file": "/tmp/agy_ctx_trace.py"` or the concrete Windows `AppData/Local/Temp/...` path.)*

## 2. Heading-Aware Docs & URLs (`ctx_index` + `ctx_search`)

1. Index once: `ctx_index({ path: "docs/spec.md", label: "Spec" })` or `ctx_index({ url: "https://..." })`. Markdown documents preserve heading breadcrumbs (`H1 > H2 > H3`) and fenced code blocks.
2. Search repeatedly via Porter BM25 + Trigram RRF: `ctx_search({ queries: ["rate limit", "OAuthError"], limit: 5 })`.
3. After `/compact`, call `ctx_resume({})` to recover recent indexed `sourceId` handles plus the structured `sessionCheckpoint` (modified files + latest test/build status) while clearing session read-dedup entries.

## 3. Transparent CLI Filtering, SmartCrusher, Config & Read Dedup

- Single noisy commands (`git status/diff/log`, `npm/pnpm/yarn/node/pytest/cargo/go` tests, builds, linters, installs, `docker build`, `gh`, `kubectl`, `terraform`, `playwright`) and safe `cd <dir> && <cmd> 2>&1` wrappers are transparently compacted `<= 8.8 KB` via `PreToolUse.overwrite` + `hooks/cli-filter.mjs` (preserving exact exit codes, extracting mid-log error anchors with ±3 lines on failures via `compactFailureWithErrorAnchors`, applying project `.agy-dart/filters.json`, structurally compacting large JSON/JSONL via SmartCrusher, and indexing redacted raw output into FTS5). Background streaming tasks (`WaitMsBeforeAsync <= 2000` or `IsDaemon: true`) and long `>60s` builds bypass `cli-filter.mjs` automatically so `manage_task(status)` receives live streaming logs.
- `ctx_index({ url })` enforces SSRF protection (`http:`/`https:` only, max 5 redirects, per-hop DNS private/loopback/IPv6-mapped blocking with IP pinning), and common credentials are redacted before indexing/returning.
- Redundant unchanged `read_file` calls (`>= readDedupMinBytes`, default 4 KB actual requested slice) in the same direct conversation are caught on strike 1 (retry once to bypass), automatically invalidate on `/compact`, rollbacks, or first-turn silent auto-compaction, and decay after `readDedupMaxSteps` (default 40 steps) or `readDedupMaxTurns` (default 12 LLM turns) so deep long-horizon tasks never waste invocations re-verifying earlier files. Opt-in modified-file compact diff-read (`diffRead: true` in `~/.agy-dart/config.json` or `AGY_DART_ENABLE_DIFF_READ=1`) is OFF by default and strictly scoped to the same direct conversation within recent turns/age.
- Unified config: configure persistent toggles in `~/.agy-dart/config.json` (overridable via `AGY_DART_*` env vars, including `readGuardMode: "soft"|"strict"|"off"`, `readDedupMinBytes`, `readDedupMaxSteps`, `readDedupMaxTurns`, `noiseMaxReadBytes`, `reviewMaxReadBytes`, `shellDumpMaxBytes`, `exemptPaths`, `exemptExtensions`); run `node scripts/install.mjs doctor` or `ctx_doctor` to inspect effective settings and cutoff provenance.

## 4. KV-Cache Diagnostics, Audit, Simulation & DB Maintenance

- Check live Prompt Cache hit rate, 1s TTL countdown, 7-bucket context composition, subagent breakdown, feature ROI (`featureRoi`), **Stall Watchdog** (dual-source execution state machine, dynamic silence thresholds, root-cause troubleshooting, opt-in desktop notifications), and one-click **Handoff / Rescue Brief** in the **agy-dart Context** Aux Pane Sidecar dashboard (or run `ctx_stats` / `ctx_doctor`).
- Prune stale entries (>14 days) and reclaim disk space: `ctx_purge({ scope: "stale", olderThanDays: 14, vacuum: true })`.
- Run offline cache audit, policy replay, prefix budget & transcript benchmarks (install with `--with-devtools` or run from source repo):
  ```bash
  npm run prefix:budget
  npm run cache:audit -- --workspace . --no-live
  npm run cache:simulate
  ```
