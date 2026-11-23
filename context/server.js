#!/usr/bin/env node
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { enableVersionedCompileCache } from "../hooks/compile-cache.mjs";

try {
  enableVersionedCompileCache();
} catch {}

const [{ stableSortObject }, { ContextModeStore }, { createTools }, handoffMod] = await Promise.all([
  import("./lib/stable-json.js"),
  import("./lib/store.js"),
  import("./lib/tools.js"),
  import("./lib/handoff.js").catch(() => ({}))
]);
const inferWorkspaceFromStore =
  typeof handoffMod?.inferWorkspaceFromStore === "function" ? handoffMod.inferWorkspaceFromStore : null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const IS_INSTALLED_PLUGIN_COPY = !fs.existsSync(path.join(PLUGIN_ROOT, ".git"));
let pkgVersion = "1.6.0";
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
  if (pkg.version) pkgVersion = pkg.version;
} catch {}

const RESERVED_SESSION_SENTINELS = new Set(["all", "lifetime", "app"]);
const INSTALLED_PLUGIN_PATH_RE =
  /\/(?:\.gemini\/(?:config|antigravity)\/plugins|\.agents\/plugins|\.t3\/userdata\/providers\/antigravity\/[^/]+\/(?:\.gemini\/config\/)?plugins)\/agy-dart(?:\/|$)/i;

function normalizeCompareDir(dirPath) {
  let resolved = path.resolve(String(dirPath || ""));
  try {
    resolved = fs.realpathSync(resolved);
  } catch {}
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrSubDir(candidateNorm, parentNorm) {
  if (!candidateNorm || !parentNorm) return false;
  const rel = path.relative(parentNorm, candidateNorm);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel))
  );
}

const PLUGIN_ROOT_NORM = normalizeCompareDir(PLUGIN_ROOT);

function isInsideInstalledPluginDir(candidateDir) {
  if (typeof candidateDir !== "string" || !candidateDir.trim()) return false;
  const candNorm = normalizeCompareDir(candidateDir);
  const candPosix = candNorm.replace(/\\/g, "/");
  if (INSTALLED_PLUGIN_PATH_RE.test(candPosix)) return true;
  for (const envVar of [process.env.PLUGIN_ROOT, process.env.AGY_PLUGIN_ROOT]) {
    if (typeof envVar === "string" && envVar.trim()) {
      if (isSameOrSubDir(candNorm, normalizeCompareDir(envVar.trim()))) return true;
    }
  }
  if (IS_INSTALLED_PLUGIN_COPY && isSameOrSubDir(candNorm, PLUGIN_ROOT_NORM)) {
    return true;
  }
  return false;
}

function resolveDirectoryCandidate(raw) {
  if (typeof raw !== "string") return null;
  let candidate = raw.trim();
  if (!candidate) return null;
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return null;
    }
  }
  try {
    const abs = path.resolve(candidate);
    if (fs.statSync(abs).isDirectory()) return abs;
  } catch {}
  return null;
}

function isExplicitAbsoluteCwdArg(raw) {
  if (typeof raw !== "string") return false;
  let s = raw.trim();
  while (s.length >= 2) {
    const q = s[0];
    if ((q === '"' || q === "'") && s[s.length - 1] === q) {
      const inner = s.slice(1, -1);
      if (inner.includes(q)) break;
      s = inner.trim();
      continue;
    }
    break;
  }
  if (!s) return false;
  if (/^file:\/\//i.test(s)) {
    try {
      return path.isAbsolute(fileURLToPath(s));
    } catch {
      return false;
    }
  }
  if (
    s === "~" ||
    s.startsWith("~/") ||
    s.startsWith("~\\") ||
    /^(?:\$\{(?:env:)?(?:TMPDIR|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA)\}|\$(?:env:)?(?:TMPDIR|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA)|%(?:TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA)%)(?=$|[\\/])/i.test(s)
  ) {
    return true;
  }
  return path.isAbsolute(s);
}

const store = new ContextModeStore();
const envWorkspaceDir =
  resolveDirectoryCandidate(process.env.ANTIGRAVITY_WORKSPACE_ROOT) ||
  resolveDirectoryCandidate(process.env.VSCODE_CWD);
let currentCwd = envWorkspaceDir || process.cwd();
let explicitWorkspaceConfigured = Boolean(envWorkspaceDir && !isInsideInstalledPluginDir(envWorkspaceDir));
let clientSupportsRoots = false;
let cachedRootsDir = null;
let rootsQueried = false;
let rootsEpoch = 0;
let inFlightRootsPromise = null;
let nextRootsReqSeq = 1;
const pendingClientRequests = new Map();
let initSessionId = null;
const callContext = new AsyncLocalStorage();

function normalizeCallSessionId(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return null;
  if (/[\x00-\x1f\x7f\\/]/.test(trimmed)) return null;
  if (RESERVED_SESSION_SENTINELS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function resolveSessionIdForCall() {
  return (
    callContext.getStore()?.sessionId ||
    initSessionId ||
    normalizeCallSessionId(process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID) ||
    normalizeCallSessionId(process.env.ANTIGRAVITY_PARENT_CONVERSATION_ID) ||
    normalizeCallSessionId(process.env.ANTIGRAVITY_CONVERSATION_ID) ||
    normalizeCallSessionId(process.env.CONVERSATION_ID) ||
    "default"
  );
}

function resolveActiveWorkspaceState() {
  if (explicitWorkspaceConfigured) {
    return { cwd: currentCwd, confirmed: true };
  }
  if (cachedRootsDir) {
    return { cwd: cachedRootsDir, confirmed: true };
  }
  const insidePlugin = isInsideInstalledPluginDir(currentCwd);
  if (insidePlugin && inferWorkspaceFromStore) {
    const inferred = inferWorkspaceFromStore(store, resolveSessionIdForCall());
    if (inferred && !isInsideInstalledPluginDir(inferred)) {
      return { cwd: inferred, confirmed: true };
    }
  }
  return { cwd: currentCwd, confirmed: !insidePlugin };
}

function resolveActiveWorkspaceCwd() {
  return resolveActiveWorkspaceState().cwd;
}

const tools = createTools({
  store,
  getCwd: resolveActiveWorkspaceCwd,
  getWorkspaceState: resolveActiveWorkspaceState,
  getSessionId: resolveSessionIdForCall,
  getDirectConversationId: () =>
    callContext.getStore()?.directConversationId ||
    callContext.getStore()?.sessionId ||
    initSessionId ||
    normalizeCallSessionId(process.env.ANTIGRAVITY_CONVERSATION_ID) ||
    normalizeCallSessionId(process.env.CONVERSATION_ID) ||
    "default"
});

// Deterministic, compact Turn-0 tool schemas (keeps server KV-cache prefix lean and stable)
const RAW_TOOL_DEFINITIONS = [
  {
    name: "ctx_batch",
    description: "Run sequential shell commands, index output into FTS5, and return matching snippets (<=8.8 KB).",
    inputSchema: {
      type: "object",
      properties: {
        commands: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        queries: { type: "array", items: { type: "string" } }
      },
      required: ["commands"]
    }
  },
  {
    name: "ctx_doctor",
    description: "Check SQLite WAL/FTS5 health, DB size, feature toggles, and runtimes.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "ctx_execute",
    description: "Run JS/Python/Shell/PowerShell in sandbox to filter >16 KB logs or giant JSON/CSV/API data (<=8.8 KB inline + FTS5). Pass short intent first; for >5-line scripts, write to conversation scratch dir (or OS temp) and pass file + args.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string" },
        language: { type: "string", enum: ["javascript", "nodejs", "python", "shell", "powershell", "cmd"] },
        code: { type: "string" },
        file: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        sessionId: { type: "string" },
        timeoutSec: { type: "integer", minimum: 1, maximum: 300 }
      }
    }
  },
  {
    name: "ctx_index",
    description: "Index local file, URL, or raw text into SQLite FTS5 (heading-aware for Markdown).",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        path: { type: "string" },
        url: { type: "string" },
        content: { type: "string" },
        label: { type: "string" }
      }
    }
  },
  {
    name: "ctx_purge",
    description: "Purge indexed sources/events for session, worktree, all, or stale TTL entries (optional VACUUM).",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        scope: { type: "string", enum: ["session", "worktree", "all", "stale"] },
        sessionId: { type: "string" },
        olderThanDays: { type: "integer" },
        vacuum: { type: "boolean" }
      }
    }
  },
  {
    name: "ctx_resume",
    description: "Recover indexed sources/events and PostToolUse checkpoint after /compact.",
    inputSchema: {
      type: "object",
      properties: {
        seq: { type: "integer" },
        sessionId: { type: "string" }
      }
    }
  },
  {
    name: "ctx_search",
    description: "Search SQLite FTS5 sources via Porter BM25 + Trigram RRF.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        queries: { type: "array", items: { type: "string" } },
        sourceId: { type: "string" },
        scope: { type: "string", enum: ["session", "worktree", "all"] },
        limit: { type: "integer" },
        offset: { type: "integer" }
      },
      required: ["queries"]
    }
  },
  {
    name: "ctx_stats",
    description: "Show context savings report (sandbox, CLI filter, read dedup, interceptions).",
    inputSchema: {
      type: "object",
      properties: {
        reset: { type: "boolean" },
        sessionId: { type: "string" }
      }
    }
  }
];

export const TOOL_DEFINITIONS = Object.freeze(
  RAW_TOOL_DEFINITIONS
    .map((def) => stableSortObject(def))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
);

process.stdout.on("error", (err) => {
  if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) return;
});

function sendJsonRpc(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch {}
}

function requestClientRootsList(timeoutMs = 1000) {
  if (stdinClosed) return Promise.resolve(null);
  if (inFlightRootsPromise) return inFlightRootsPromise;
  inFlightRootsPromise = new Promise((resolve) => {
    const reqId = `agy-ctx-roots-${nextRootsReqSeq++}`;
    const timer = setTimeout(() => {
      pendingClientRequests.delete(reqId);
      resolve(null);
    }, timeoutMs);
    timer.unref();
    pendingClientRequests.set(reqId, {
      timer,
      resolve: (respMsg) => {
        clearTimeout(timer);
        const roots = respMsg?.result?.roots;
        if (Array.isArray(roots)) {
          for (const item of roots) {
            const candidate = resolveDirectoryCandidate(item?.uri || item?.path);
            if (candidate && !isInsideInstalledPluginDir(candidate)) {
              resolve(candidate);
              return;
            }
          }
        }
        resolve(null);
      }
    });
    sendJsonRpc({ jsonrpc: "2.0", id: reqId, method: "roots/list" });
  });
  const trackedPromise = inFlightRootsPromise.finally(() => {
    if (inFlightRootsPromise === trackedPromise) {
      inFlightRootsPromise = null;
    }
  });
  inFlightRootsPromise = trackedPromise;
  return trackedPromise;
}

function sendResponse(id, result) {
  sendJsonRpc({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  sendJsonRpc({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) }
  });
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

let inFlightCalls = 0;
let stdinClosed = false;
let shuttingDown = false;

function cancelPendingClientRequests() {
  for (const [, pending] of pendingClientRequests) {
    clearTimeout(pending.timer);
    pending.resolve(null);
  }
  pendingClientRequests.clear();
}

function gracefulFlushAndExit() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    store.close();
  } catch {}
  const forceTimer = setTimeout(() => {
    process.exit(0);
  }, 150);
  forceTimer.unref();
  try {
    process.stdout.end(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
  } catch {
    process.exit(0);
  }
}

function maybeCloseStoreOnDrain() {
  if (stdinClosed && inFlightCalls === 0) {
    gracefulFlushAndExit();
  }
}

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    sendError(null, -32700, "Parse error", String(err));
    return;
  }

  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    sendError(null, -32600, "Invalid Request", "JSON-RPC message must be a JSON object");
    return;
  }

  const { id, method, params } = msg;
  const hasId = id !== undefined && id !== null;
  if (
    hasId &&
    !method &&
    (Object.prototype.hasOwnProperty.call(msg, "result") ||
      Object.prototype.hasOwnProperty.call(msg, "error"))
  ) {
    const pending = pendingClientRequests.get(String(id));
    if (pending) {
      pendingClientRequests.delete(String(id));
      pending.resolve(msg);
    }
    return;
  }
  if (!hasId) {
    if (method === "notifications/roots/list_changed") {
      rootsEpoch += 1;
      cachedRootsDir = null;
      rootsQueried = false;
      inFlightRootsPromise = null;
    }
    return;
  }

  inFlightCalls += 1;
  try {
    switch (method) {
      case "initialize": {
        clientSupportsRoots = Boolean(
          params?.capabilities && typeof params.capabilities === "object" && params.capabilities.roots
        );
        const initCandidates = [
          ...(Array.isArray(params?.workspaceFolders)
            ? params.workspaceFolders.map((w) => w?.uri || w?.path)
            : []),
          params?.rootUri,
          params?.rootPath
        ];
        for (const cand of initCandidates) {
          const resolved = resolveDirectoryCandidate(cand);
          if (resolved && !isInsideInstalledPluginDir(resolved)) {
            currentCwd = resolved;
            explicitWorkspaceConfigured = true;
            break;
          }
        }
        const initSid = normalizeCallSessionId(params?.sessionId);
        if (initSid) initSessionId = initSid;
        sendResponse(id, {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "agy-dart-context",
            version: pkgVersion
          }
        });
        break;
      }

      case "ping": {
        sendResponse(id, {});
        break;
      }

      case "tools/list": {
        sendResponse(id, { tools: TOOL_DEFINITIONS });
        break;
      }

      case "tools/call": {
        const toolName = params?.name;
        const rawToolArgs = params?.arguments;
        let toolArgs = {};
        if (rawToolArgs !== undefined && rawToolArgs !== null) {
          if (typeof rawToolArgs === "string") {
            try {
              const parsedArgs = JSON.parse(rawToolArgs);
              if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
                sendError(id, -32602, "Invalid params: 'arguments' must decode to a JSON object");
                break;
              }
              toolArgs = parsedArgs;
            } catch {
              sendError(id, -32602, "Invalid params: 'arguments' string is not valid JSON");
              break;
            }
          } else if (typeof rawToolArgs === "object" && !Array.isArray(rawToolArgs)) {
            toolArgs = rawToolArgs;
          } else {
            sendError(id, -32602, "Invalid params: 'arguments' must be a JSON object");
            break;
          }
        }
        if (
          !explicitWorkspaceConfigured &&
          !rootsQueried &&
          !stdinClosed &&
          !isExplicitAbsoluteCwdArg(toolArgs.cwd) &&
          (clientSupportsRoots || isInsideInstalledPluginDir(currentCwd))
        ) {
          const epoch = rootsEpoch;
          const rootsDir = await requestClientRootsList(1000);
          if (rootsEpoch === epoch) {
            rootsQueried = true;
            cachedRootsDir = rootsDir;
          }
        }
        // Strictly per-call session isolation via AsyncLocalStorage: never mutate process-global
        // session state across concurrent conversations sharing one long-lived MCP stdio server.
        const hostIds = [params?._meta?.rootConversationId, params?._meta?.conversationId, params?._meta?.sessionId, params?.sessionId];
        const argumentIds = [toolArgs.sessionId, toolArgs.conversationId];
        // The host owns execution attribution. Other tools support explicit cross-session queries.
        const candidates = toolName === "ctx_execute" ? [...hostIds, ...argumentIds] : [...argumentIds, ...hostIds];
        const callSessionId = candidates.map(normalizeCallSessionId).find(Boolean) ?? null;
        const callDirectConvId =
          [
            toolArgs.conversationId,
            toolArgs.sessionId,
            params?._meta?.conversationId,
            params?._meta?.sessionId,
            params?.sessionId
          ]
            .map(normalizeCallSessionId)
            .find(Boolean) ?? null;

        if (typeof toolName !== "string" || !Object.hasOwn(tools, toolName)) {
          sendError(id, -32601, `Unknown tool: ${toolName}`);
          break;
        }

        try {
          const result = await callContext.run(
            { sessionId: callSessionId, directConversationId: callDirectConvId },
            () => tools[toolName](toolArgs)
          );
          sendResponse(id, {
            content: [
              {
                type: "text",
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
              }
            ],
            isError: false
          });
        } catch (toolErr) {
          sendResponse(id, {
            content: [
              {
                type: "text",
                text: `Tool error (${toolName}): ${toolErr.message || String(toolErr)}`
              }
            ],
            isError: true
          });
        }
        break;
      }

      default: {
        sendError(id, -32601, `Method not found: ${method}`);
        break;
      }
    }
  } catch (handlerErr) {
    sendError(id, -32603, "Internal server error", String(handlerErr));
  } finally {
    inFlightCalls = Math.max(0, inFlightCalls - 1);
    maybeCloseStoreOnDrain();
  }
});

rl.on("close", () => {
  stdinClosed = true;
  cancelPendingClientRequests();
  maybeCloseStoreOnDrain();
});

const exitImmediately = () => {
  try {
    store.close();
  } catch {}
  process.exit(0);
};

process.on("SIGINT", exitImmediately);
process.on("SIGTERM", exitImmediately);
if (process.platform === "win32") {
  process.on("SIGBREAK", exitImmediately);
}
