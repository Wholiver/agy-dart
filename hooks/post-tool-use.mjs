#!/usr/bin/env node
/**
 * agy-dart PostToolUse hook:
 * Invalidates session-level `file_reads` entries whenever a file is edited/written
 * (edit_file, write_file, replace_file_content, apply_edits) while keeping
 * `file_snapshots` intact as the diff baseline for State-3 compact diff-read.
 * When `ctx_resume` is called after conversation compaction, invalidates BOTH
 * `file_reads` and `file_snapshots` for the session.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enableVersionedCompileCache } from "./compile-cache.mjs";
import { getEffectiveConfig } from "../context/lib/config.js";
import { executionReceiptFromText, isContextExecution } from "../context/lib/execution-receipts.js";

function readStdin(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const onData = (chunk) => {
      data += chunk;
    };
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", done);
      process.stdin.off("error", done);
      try {
        process.stdin.pause();
        process.stdin.unref?.();
      } catch {}
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

function resolveSessionId(payload = {}) {
  return (
    payload.rootConversationId ||
    payload.root_conversation_id ||
    payload.parentConversationId ||
    payload.parent_conversation_id ||
    payload.conversationId ||
    payload.conversation_id ||
    payload.common?.conversationId ||
    payload.common?.conversation_id ||
    payload.sessionId ||
    payload.session_id ||
    process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_PARENT_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    "default"
  );
}

function resolveDirectConversationId(payload = {}) {
  return (
    payload.conversationId ||
    payload.conversation_id ||
    payload.common?.conversationId ||
    payload.common?.conversation_id ||
    payload.sessionId ||
    payload.session_id ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    "default"
  );
}

function cleanPath(val) {
  if (!val) return "";
  let p = String(val).trim();
  while ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
  p = p.replace(/#L\d+(-L\d+)?$/i, "");
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      let rest = p.replace(/^file:\/\//i, "");
      try {
        rest = decodeURIComponent(rest);
      } catch {}
      if (/^\/[A-Za-z]:[\\/]/.test(rest)) {
        rest = rest.slice(1);
      }
      p = rest;
    }
  }
  return p.trim();
}

function expandHookPath(val) {
  const p = cleanPath(val);
  if (!p) return "";
  const joinExpandedTail = (base, rawTail) => {
    const segs = String(rawTail || "").split(/[\\/]+/).filter(Boolean);
    return segs.length > 0 ? path.join(base, ...segs) : base;
  };
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return joinExpandedTail(os.homedir(), p.slice(2));
  }
  const tmpMatch = p.match(
    /^(?:\$\{(?:env:)?(?:TMPDIR|TEMP|TMP)\}|\$(?:env:)?(?:TMPDIR|TEMP|TMP)|%(?:TEMP|TMP)%)(?=$|[\\/])(.*)$/i
  );
  if (tmpMatch) {
    return joinExpandedTail(os.tmpdir(), tmpMatch[1]);
  }
  const homeMatch = p.match(
    /^(?:\$\{(?:env:)?(?:HOME|USERPROFILE)\}|\$(?:env:)?(?:HOME|USERPROFILE)|%(?:HOME|USERPROFILE)%)(?=$|[\\/])(.*)$/i
  );
  if (homeMatch) {
    return joinExpandedTail(os.homedir(), homeMatch[1]);
  }
  const localAppMatch = p.match(
    /^(?:\$\{(?:env:)?LOCALAPPDATA\}|\$(?:env:)?LOCALAPPDATA|%LOCALAPPDATA%)(?=$|[\\/])(.*)$/i
  );
  if (localAppMatch) {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return joinExpandedTail(base, localAppMatch[1]);
  }
  return p;
}

function stripHostNamespace(rawToolName) {
  const s = String(rawToolName || "").trim();
  const colonIdx = s.lastIndexOf(":");
  return colonIdx >= 0 ? s.slice(colonIdx + 1) : s;
}

function parseMaybeJson(val) {
  if (!val) return null;
  if (typeof val === "object") return val;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return null;
    }
  }
  return null;
}

export function extractInvalidationTargets(toolName, args = {}, cwd = process.cwd()) {
  const paths = [];
  let clearAllSession = false;
  const bareTool = stripHostNamespace(toolName);

  const addPath = (raw, baseDir = cwd) => {
    const cleaned = expandHookPath(raw);
    if (!cleaned) return;
    paths.push(path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(baseDir || cwd, cleaned));
  };

  const resolveBaseCwd = (rawCwd) => {
    const cleaned = expandHookPath(rawCwd);
    if (!cleaned) return cwd;
    return path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(cwd, cleaned);
  };

  if (
    bareTool === "edit_file" ||
    bareTool === "write_file" ||
    bareTool === "replace_file_content" ||
    bareTool === "multi_replace_file_content" ||
    bareTool === "write_to_file"
  ) {
    addPath(args.Path || args.path || args.TargetFile || args.targetFile || args.filePath || args.AbsolutePath || args.absolutePath);
  } else if (bareTool === "apply_edits" || /(?:^|_)apply_edits$/.test(bareTool)) {
    if (!args.dryRun) {
      const editCwd = resolveBaseCwd(args.cwd);
      const editsList = Array.isArray(args.edits) ? args.edits : parseMaybeJson(args.edits);
      if (Array.isArray(editsList)) {
        for (const e of editsList) {
          if (e && e.path) addPath(e.path, editCwd);
        }
      }
    }
  } else if (bareTool === "call_mcp_tool") {
    const mcpTool = stripHostNamespace(cleanPath(args.ToolName || args.toolName || ""));
    const mcpArgs = parseMaybeJson(args.Arguments ?? args.arguments) || {};
    if (mcpTool === "apply_edits" || /(?:^|_)apply_edits$/.test(mcpTool)) {
      if (!mcpArgs.dryRun) {
        const editCwd = resolveBaseCwd(mcpArgs.cwd);
        const editsList = Array.isArray(mcpArgs.edits) ? mcpArgs.edits : parseMaybeJson(mcpArgs.edits);
        if (Array.isArray(editsList)) {
          for (const e of editsList) {
            if (e && e.path) addPath(e.path, editCwd);
          }
        }
      }
    } else if (mcpTool === "ctx_resume" || /(?:^|_)ctx_resume$/.test(mcpTool)) {
      if (mcpArgs.seq === undefined || mcpArgs.seq === null) {
        clearAllSession = true;
      }
    }
  } else if (bareTool === "ctx_resume" || /(?:^|_)ctx_resume$/.test(bareTool)) {
    if (args.seq === undefined || args.seq === null) {
      clearAllSession = true;
    }
  }

  return { paths, clearAllSession };
}

const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_NON_CONV_SEGMENTS = new Set([
  "default",
  "all",
  "app",
  "lifetime",
  "main",
  "master",
  "test",
  "tests",
  "core",
  "util",
  "utils",
  "src",
  "lib",
  "dist",
  "build",
  "docs",
  "scripts"
]);
const SOURCE_TREE_PARENT_SEGMENTS = new Set([
  "src",
  "lib",
  "app",
  "packages",
  "modules",
  "components",
  "services",
  "server",
  "client",
  "node_modules",
  "vendor",
  "test",
  "tests"
]);

function resolveRealPathBestEffort(resolvedPath) {
  try {
    return fs.realpathSync(resolvedPath);
  } catch {
    let cur = path.dirname(resolvedPath);
    const tail = [path.basename(resolvedPath)];
    for (let i = 0; i < 16 && cur; i += 1) {
      try {
        const realCur = fs.realpathSync(cur);
        return path.join(realCur, ...tail.reverse());
      } catch {
        const parent = path.dirname(cur);
        if (!parent || parent === cur) break;
        tail.push(path.basename(cur));
        cur = parent;
      }
    }
    return null;
  }
}

function isWinDriveLike(p) {
  return typeof p === "string" && /^\/?[A-Za-z]:(?:$|[\\/])/.test(p);
}

function normalizeWinDriveToSyntheticPosix(rawWinPath) {
  const s = rawWinPath.startsWith("/") ? rawWinPath.slice(1) : rawWinPath;
  const drive = s[0].toLowerCase();
  const rest = s.slice(2).replace(/\\/g, "/");
  const normRest = path.posix.normalize("/" + rest).toLowerCase();
  return normRest === "/" ? `/${drive}:` : `/${drive}:${normRest.replace(/\/+$/, "")}`;
}

function resolvePathBundle(rawPath, baseDir = "", { platform = process.platform } = {}) {
  const cleaned = expandHookPath(rawPath);
  if (!cleaned) return null;
  const effPlatform = platform || process.platform;

  if (effPlatform !== "win32" && isWinDriveLike(cleaned)) {
    const winPosix = normalizeWinDriveToSyntheticPosix(cleaned);
    return { logical: winPosix, real: winPosix, allForms: [winPosix] };
  }

  if (effPlatform !== process.platform) {
    const cleanedBase = expandHookPath(baseDir);
    if (effPlatform !== "win32") {
      const candPosix = cleaned.replace(/\\/g, "/");
      const basePosix = cleanedBase && !isWinDriveLike(cleanedBase) ? cleanedBase.replace(/\\/g, "/") : "";
      const resolved =
        !path.posix.isAbsolute(candPosix) && basePosix
          ? path.posix.resolve(basePosix, candPosix)
          : path.posix.resolve("/", candPosix);
      return { logical: resolved, real: resolved, allForms: [resolved] };
    }
    const resolvedWin = (
      !path.win32.isAbsolute(cleaned) && cleanedBase
        ? path.win32.resolve(cleanedBase, cleaned)
        : path.win32.resolve(cleaned)
    ).toLowerCase();
    return { logical: resolvedWin, real: resolvedWin, allForms: [resolvedWin] };
  }

  const cleanedBase = expandHookPath(baseDir);
  const resolved =
    !path.isAbsolute(cleaned) && cleanedBase ? path.resolve(cleanedBase, cleaned) : path.resolve(cleaned);
  const normCase = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const logical = normCase(resolved);
  const realRaw = resolveRealPathBestEffort(resolved);
  const real = realRaw ? normCase(realRaw) : logical;
  const allForms = real !== logical ? [logical, real] : [logical];
  return { logical, real, allForms };
}

function relativeBetweenForms(dirForm, candForm) {
  if (dirForm.startsWith("/") && candForm.startsWith("/")) {
    return path.posix.relative(dirForm, candForm);
  }
  if (/^[a-zA-Z]:[\\/]/.test(dirForm) && /^[a-zA-Z]:[\\/]/.test(candForm)) {
    return path.win32.relative(dirForm, candForm);
  }
  return path.relative(dirForm, candForm);
}

function isSameOrInsideAnyDir(candForms, dirForms, { strictChild = false } = {}) {
  for (const c of candForms) {
    for (const d of dirForms) {
      if (!c || !d) continue;
      const rel = relativeBetweenForms(d, c);
      if (rel === "") {
        if (!strictChild) return true;
        continue;
      }
      if (
        rel !== ".." &&
        !rel.startsWith(`..${path.sep}`) &&
        !rel.startsWith("../") &&
        !rel.startsWith("..\\") &&
        !path.posix.isAbsolute(rel) &&
        !path.win32.isAbsolute(rel)
      ) {
        return true;
      }
    }
  }
  return false;
}

function isInsideBrainConversationSubdir(candForms, brainDirForms) {
  for (const c of candForms) {
    for (const d of brainDirForms) {
      if (!c || !d) continue;
      const rel = relativeBetweenForms(d, c);
      if (
        !rel ||
        rel === ".." ||
        rel.startsWith(`..${path.sep}`) ||
        rel.startsWith("../") ||
        rel.startsWith("..\\") ||
        path.posix.isAbsolute(rel) ||
        path.win32.isAbsolute(rel)
      ) {
        continue;
      }
      const parts = rel.split(/[\\/]+/).filter(Boolean);
      if (parts.length >= 2 && parts[0] !== "." && parts[0] !== "..") {
        return true;
      }
    }
  }
  return false;
}

function isAbsoluteForAnyOs(p) {
  return Boolean(p && (path.isAbsolute(p) || path.posix.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)));
}

function pathModFor(p) {
  return /^[A-Za-z]:[\\/]/.test(p) ? path.win32 : path.posix.isAbsolute(p) && process.platform === "win32" && !p.startsWith("\\\\") ? path.posix : path;
}

export function isEphemeralOsTempPathOutsideWorkspace(absPath, workspaceCwd = "", options = {}) {
  const effPlatform = options?.platform || process.platform;
  const candBundle = resolvePathBundle(absPath, workspaceCwd, { platform: effPlatform });
  if (!candBundle) return false;
  if (workspaceCwd && typeof workspaceCwd === "string" && workspaceCwd.trim()) {
    const wsBundle = resolvePathBundle(workspaceCwd, "", { platform: effPlatform });
    if (wsBundle && isSameOrInsideAnyDir(candBundle.allForms, wsBundle.allForms)) {
      return false;
    }
  }
  const rawTmpCandidates = [
    os.tmpdir(),
    process.env.TMPDIR,
    process.env.TEMP,
    process.env.TMP,
    ...(effPlatform !== "win32" ? ["/tmp", "/private/tmp", "/var/tmp"] : [])
  ];
  // Require the canonical real target (`candBundle.real`) to reside inside an OS temp dir so a
  // symlink/junction inside %TEMP% or /tmp pointing to an external repo file is never excluded.
  for (const tmpCand of rawTmpCandidates) {
    if (!tmpCand || typeof tmpCand !== "string" || !tmpCand.trim() || !isAbsoluteForAnyOs(tmpCand.trim())) {
      continue;
    }
    const tmpBundle = resolvePathBundle(tmpCand, "", { platform: effPlatform });
    if (tmpBundle && isSameOrInsideAnyDir([candBundle.real], tmpBundle.allForms, { strictChild: true })) {
      return true;
    }
  }
  return false;
}

export function isAntigravityBrainPathOutsideWorkspace(absPath, workspaceCwd = "", options = {}) {
  const effPlatform = options?.platform || process.platform;
  const candBundle = resolvePathBundle(absPath, workspaceCwd, { platform: effPlatform });
  if (!candBundle) return false;
  if (workspaceCwd && typeof workspaceCwd === "string" && workspaceCwd.trim()) {
    const wsBundle = resolvePathBundle(workspaceCwd, "", { platform: effPlatform });
    if (wsBundle && isSameOrInsideAnyDir(candBundle.allForms, wsBundle.allForms)) {
      return false;
    }
  }

  const knownBrainDirCandidates = [];
  const pushBrainDir = (rawDir) => {
    const cleaned = expandHookPath(rawDir);
    if (cleaned && isAbsoluteForAnyOs(cleaned)) {
      knownBrainDirCandidates.push(cleaned);
    }
  };

  for (const appDir of [
    options?.appDataDir,
    process.env.ANTIGRAVITY_APP_DATA_DIR,
    process.env.ANTIGRAVITY_DATA_DIR,
    process.env.AGY_APP_DATA_DIR
  ]) {
    const cleanedApp = expandHookPath(appDir);
    if (cleanedApp && isAbsoluteForAnyOs(cleanedApp)) {
      pushBrainDir(pathModFor(cleanedApp).join(cleanedApp, "brain"));
    }
  }
  const summaryDbEnv = expandHookPath(options?.summaryDbPath || process.env.AGY_DART_SUMMARY_DB_PATH);
  if (summaryDbEnv && isAbsoluteForAnyOs(summaryDbEnv)) {
    const pm = pathModFor(summaryDbEnv);
    pushBrainDir(pm.join(pm.dirname(summaryDbEnv), "brain"));
  }
  const txPath = expandHookPath(options?.transcriptPath);
  if (txPath && isAbsoluteForAnyOs(txPath)) {
    const pm = pathModFor(txPath);
    let cur = pm.dirname(txPath);
    for (let depth = 0; depth < 7 && cur; depth += 1) {
      if (pm.basename(cur).toLowerCase() === "brain") {
        pushBrainDir(cur);
        break;
      }
      const next = pm.dirname(cur);
      if (!next || next === cur) break;
      cur = next;
    }
  }
  for (const homeCand of [os.homedir(), process.env.USERPROFILE, process.env.HOME]) {
    const cleanedHome = expandHookPath(homeCand);
    if (cleanedHome && isAbsoluteForAnyOs(cleanedHome)) {
      const pm = pathModFor(cleanedHome);
      pushBrainDir(pm.join(cleanedHome, ".gemini", "antigravity", "brain"));
      pushBrainDir(pm.join(cleanedHome, ".gemini", "antigravity-ide", "brain"));
      pushBrainDir(pm.join(cleanedHome, ".gemini", "antigravity-cli", "brain"));
    }
  }

  // Require the canonical target (`candBundle.real`) to remain inside `<brain>/<convId>/...` so
  // symlinks/junctions inside `brain/<convId>/scratch/` pointing to external repos are not excluded.
  for (const brainCand of knownBrainDirCandidates) {
    const brainBundle = resolvePathBundle(brainCand, "", { platform: effPlatform });
    if (brainBundle && isInsideBrainConversationSubdir([candBundle.real], brainBundle.allForms)) {
      return true;
    }
  }

  const activeConvIds = new Set();
  const rawConvList = Array.isArray(options?.conversationIds) ? options.conversationIds : [];
  for (const rawId of rawConvList) {
    if (typeof rawId !== "string") continue;
    const trimmed = rawId.trim();
    if (!trimmed || trimmed.length < 4 || trimmed.length > 128 || /[\x00-\x1f\x7f\\/]/.test(trimmed)) continue;
    const lower = trimmed.toLowerCase();
    if (GENERIC_NON_CONV_SEGMENTS.has(lower)) continue;
    activeConvIds.add(effPlatform === "win32" ? lower : trimmed);
    activeConvIds.add(lower);
  }

  const isAntigravityHostSeg = (seg) => seg === "antigravity" || /^antigravity-[a-z0-9._-]+$/i.test(seg);

  for (const cand of candBundle.allForms) {
    const segs = cand.replace(/\\/g, "/").split("/");
    for (let i = 0; i < segs.length; i += 1) {
      if (segs[i].toLowerCase() !== "brain") continue;
      const convSeg = segs[i + 1] || "";
      if (!convSeg || convSeg === "." || convSeg === ".." || convSeg.length > 128) continue;
      const hasChildFile = segs.slice(i + 2).some(Boolean);
      if (!hasChildFile) continue;

      const prev1 = (segs[i - 1] || "").toLowerCase();
      const prev2 = (segs[i - 2] || "").toLowerCase();
      const hasAgAncestry =
        prev1 === ".gemini" || isAntigravityHostSeg(prev1) || isAntigravityHostSeg(prev2);
      const isUuidConv = UUID_SEGMENT_RE.test(convSeg);
      const isActiveConv =
        !SOURCE_TREE_PARENT_SEGMENTS.has(prev1) &&
        (activeConvIds.has(convSeg) || activeConvIds.has(convSeg.toLowerCase()));
      if (!hasAgAncestry && !isUuidConv && !isActiveConv) continue;

      const matchedBrainPrefix = segs.slice(0, i + 1).join("/") || "/";
      const matchedBrainBundle = resolvePathBundle(matchedBrainPrefix, "", { platform: effPlatform });
      if (matchedBrainBundle && isInsideBrainConversationSubdir([candBundle.real], matchedBrainBundle.allForms)) {
        return true;
      }
    }
  }

  return false;
}

export function isEphemeralScratchOrTempPathOutsideWorkspace(absPath, workspaceCwd = "", options = {}) {
  return (
    isEphemeralOsTempPathOutsideWorkspace(absPath, workspaceCwd, options) ||
    isAntigravityBrainPathOutsideWorkspace(absPath, workspaceCwd, options)
  );
}

function extractResponseIsError(payload = {}) {
  if (payload.isError === true || payload.is_error === true || Boolean(payload.error)) return true;
  const candidates = [
    payload.toolResponse,
    payload.tool_response,
    payload.response,
    payload.result,
    payload.toolCall?.result
  ];
  for (const c of candidates) {
    if (c && typeof c === "object" && (c.isError === true || c.is_error === true)) return true;
  }
  return false;
}

function extractPartialAppliedPaths(responseText, toolName, args = {}, cwd = process.cwd(), candidatePaths = []) {
  if (!responseText || !/Partial edit applied\b/i.test(responseText)) return null;
  // If the MCP output was truncated to <=8.8 KB, the `Applied:` section may have clipped trailing edited files;
  // fall back conservatively to invalidating all candidate input paths so no modified file stays stale in `file_reads`.
  if (/\.\.\.\s*\[truncated/i.test(responseText) && Array.isArray(candidatePaths) && candidatePaths.length > 0) {
    return candidatePaths;
  }
  const appliedBlockMatch = responseText.match(/Applied:\r?\n([\s\S]*?)(?:\r?\n\r?\nFailed\b|$)/i);
  if (!appliedBlockMatch) return candidatePaths.length > 0 ? candidatePaths : [];

  let baseCwd = cwd;
  const resolveBase = (rawCwd) => {
    const cleaned = expandHookPath(rawCwd);
    if (!cleaned) return cwd;
    return path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(cwd, cleaned);
  };
  const bareTool = stripHostNamespace(toolName);
  if (bareTool === "apply_edits" || /(?:^|_)apply_edits$/.test(bareTool)) {
    baseCwd = resolveBase(args.cwd);
  } else if (bareTool === "call_mcp_tool") {
    const mcpArgs = parseMaybeJson(args.Arguments ?? args.arguments) || {};
    baseCwd = resolveBase(mcpArgs.cwd);
  }

  const out = [];
  for (const line of appliedBlockMatch[1].split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+(.+?):\s+(?:created|updated\b)/i);
    if (!m) continue;
    const cleaned = expandHookPath(m[1]);
    if (!cleaned) continue;
    out.push(path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(baseCwd, cleaned));
  }
  return out;
}

function extractToolResponseText(payload = {}) {
  const candidates = [
    payload.toolResponse,
    payload.tool_response,
    payload.response,
    payload.result,
    payload.output,
    payload.toolCall?.result,
    payload.toolCall?.output
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
    if (c && typeof c === "object") {
      if (typeof c.text === "string" && c.text.trim()) return c.text;
      if (Array.isArray(c.content)) {
        const joined = c.content
          .map((item) => (typeof item?.text === "string" ? item.text : ""))
          .filter(Boolean)
          .join("\n");
        if (joined.trim()) return joined;
      }
    }
  }
  return "";
}

export function extractVerificationSignal(toolName, args = {}, responseText = "") {
  if (!responseText || typeof responseText !== "string") return null;

  // Case 1: apply_edits with inline verify command
  let verifyCmd = "";
  let isRunChecks = false;
  let runChecksCmd = "";
  const bareTool = stripHostNamespace(toolName);
  if (bareTool === "apply_edits" || /(?:^|_)apply_edits$/.test(bareTool)) {
    verifyCmd = typeof args.verify === "string" ? args.verify : args.verify?.command || "";
  } else if (bareTool === "run_checks" || /(?:^|_)run_checks$/.test(bareTool)) {
    isRunChecks = true;
    const parsedCmds = Array.isArray(args.commands) ? args.commands : parseMaybeJson(args.commands);
    const cmds = Array.isArray(parsedCmds) ? parsedCmds : [];
    runChecksCmd = cmds
      .map((c) => (typeof c === "string" ? c : c?.name || c?.command || ""))
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
  } else if (bareTool === "call_mcp_tool") {
    const mcpTool = stripHostNamespace(cleanPath(args.ToolName || args.toolName || ""));
    const mcpArgs = parseMaybeJson(args.Arguments ?? args.arguments) || {};
    if (mcpTool === "apply_edits" || /(?:^|_)apply_edits$/.test(mcpTool)) {
      verifyCmd = typeof mcpArgs.verify === "string" ? mcpArgs.verify : mcpArgs.verify?.command || "";
    } else if (mcpTool === "run_checks" || /(?:^|_)run_checks$/.test(mcpTool)) {
      isRunChecks = true;
      const parsedCmds = Array.isArray(mcpArgs.commands) ? mcpArgs.commands : parseMaybeJson(mcpArgs.commands);
      const cmds = Array.isArray(parsedCmds) ? parsedCmds : [];
      runChecksCmd = cmds
        .map((c) => (typeof c === "string" ? c : c?.name || c?.command || ""))
        .filter(Boolean)
        .slice(0, 3)
        .join(", ");
    }
  }

  if (verifyCmd) {
    const m = responseText.match(/Verify \[(PASS|FAIL|TIMEOUT)[^\]]*\]\s*`?([^`\n]*)`?:/i);
    if (m) {
      const status = m[1].toUpperCase();
      const passed = status === "PASS";
      const isBuild = /\b(?:build|tsc|typecheck|lint|eslint|biome|webpack|vite|clippy)\b/i.test(verifyCmd);
      return {
        kind: isBuild ? "build" : "test",
        command: verifyCmd,
        ruleId: "apply_edits_verify",
        exitCode: passed ? 0 : 1,
        passed,
        summary: m[0].slice(0, 180)
      };
    }
  }

  if (isRunChecks) {
    const m = responseText.match(/^Checks:\s*(\d+)\/(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/m);
    if (m) {
      const passedCnt = Number(m[1]);
      const totalCnt = Number(m[2]);
      const failedCnt = m[3] ? Number(m[3]) : Math.max(0, totalCnt - passedCnt);
      const passed = failedCnt === 0 && totalCnt > 0;
      const isBuild =
        /\b(?:build|tsc|typecheck|lint|eslint|biome|check)\b/i.test(runChecksCmd) &&
        !/\btest\b/i.test(runChecksCmd);
      return {
        kind: isBuild ? "build" : "test",
        command: runChecksCmd || "run_checks",
        ruleId: "run_checks",
        exitCode: passed ? 0 : 1,
        passed,
        summary: m[0]
      };
    }
  }

  return null;
}

async function main() {
  enableVersionedCompileCache();

  const raw = (await readStdin()).trim();
  if (!raw) {
    process.stdout.write("{}\n");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write("{}\n");
    return;
  }

  const toolCall = payload.toolCall || {};
  const toolName = toolCall.name || "";
  const args = toolCall.args || {};
  const cwd = payload.cwd || process.cwd();
  const sessionId = resolveSessionId(payload);
  const directConvId = resolveDirectConversationId(payload);
  const rawTranscriptPath =
    (typeof payload.transcriptPath === "string" && payload.transcriptPath.trim()) ||
    (typeof payload.transcript_path === "string" && payload.transcript_path.trim()) ||
    (typeof payload.common?.transcriptPath === "string" && payload.common.transcriptPath.trim()) ||
    (typeof payload.common?.transcript_path === "string" && payload.common.transcript_path.trim()) ||
    "";
  const payloadConvIds = [
    sessionId,
    directConvId,
    payload.rootConversationId,
    payload.root_conversation_id,
    payload.parentConversationId,
    payload.parent_conversation_id,
    payload.conversationId,
    payload.conversation_id,
    payload.common?.conversationId,
    payload.common?.conversation_id
  ].filter(Boolean);

  const { paths, clearAllSession } = extractInvalidationTargets(toolName, args, cwd);
  const responseText = extractToolResponseText(payload);
  const receipt = isContextExecution(toolCall) && executionReceiptFromText(responseText);
  const responseIsError = extractResponseIsError(payload);
  const verifySignal = extractVerificationSignal(toolName, args, responseText);

  const effectiveCfg = getEffectiveConfig();
  const resolvedDbPath = effectiveCfg.dbPath || path.join(os.homedir(), ".agy-dart", "context.db");
  const shouldTouchWatchdog =
    Boolean(effectiveCfg.stallWatchdog) &&
    Boolean(directConvId && directConvId !== "default") &&
    (clearAllSession || paths.length > 0 || Boolean(verifySignal) || fs.existsSync(resolvedDbPath));

  if (clearAllSession || paths.length > 0 || verifySignal || shouldTouchWatchdog || receipt) {
    let store = null;
    try {
      const [{ ContextModeStore }, { redactSecrets }, watchdogLeaseMod] = await Promise.all([
        import("../context/lib/store.js"),
        import("../context/lib/security.js"),
        shouldTouchWatchdog ? import("../context/lib/watchdog-lease.js") : Promise.resolve(null)
      ]);
      store = new ContextModeStore({ hookMode: true, maxBusyRetries: 4, maxRetryDeadlineMs: 800 });
      if (receipt) store.claimExecutionReceipts(directConvId, [receipt]);
      if (clearAllSession) {
        store.invalidateFileReads(sessionId, null);
        if (directConvId && directConvId !== sessionId) {
          store.invalidateFileReads(directConvId, null);
        }
      } else if (paths.length > 0) {
        const partialApplied = extractPartialAppliedPaths(responseText, toolName, args, cwd, paths);
        const explicitlyApplied = /^\s*Applied edits to \d+ file\(s\):/im.test(responseText);
        const abortedNoWrite =
          partialApplied === null &&
          !explicitlyApplied &&
          (responseIsError ||
            /^\s*(?:(?:Atomic edit aborted|Edit aborted|Validation failed)\s*\(0 files modified\)|Write failed \(changes rolled back\)|Dry run validated|Encountered error in step execution|Tool error \(|Error(?:\s*\[[A-Z0-9_]+\])?:)/i.test(
              responseText
            ));
        const effectivePaths = partialApplied !== null ? partialApplied : abortedNoWrite ? [] : paths;
        if (effectivePaths.length > 0) {
          const invalidateSinglePath = (target) => {
            store.invalidateFileReads(sessionId, target);
            if (typeof store.clearGhostInterception === "function") {
              store.clearGhostInterception(sessionId, target);
            }
            if (directConvId && directConvId !== sessionId) {
              store.invalidateFileReads(directConvId, target);
              if (typeof store.clearGhostInterception === "function") {
                store.clearGhostInterception(directConvId, target);
              }
            }
            if (typeof store.invalidateFileReadsByPath === "function") {
              store.invalidateFileReadsByPath(target);
            }
          };
          for (const absPath of effectivePaths) {
            invalidateSinglePath(absPath);
            const realTarget = resolveRealPathBestEffort(absPath);
            if (
              realTarget &&
              (process.platform === "win32"
                ? realTarget.toLowerCase() !== absPath.toLowerCase()
                : realTarget !== absPath)
            ) {
              invalidateSinglePath(realTarget);
            }
          }
          const wsLogicalForm =
            cwd && typeof cwd === "string" && cwd.trim()
              ? (process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd))
              : "";
          const checkpointPaths = effectivePaths
            .filter(
              (absPath) =>
                !isEphemeralScratchOrTempPathOutsideWorkspace(absPath, cwd, {
                  conversationIds: payloadConvIds,
                  transcriptPath: rawTranscriptPath
                })
            )
            .map((absPath) => {
              const absForm = process.platform === "win32" ? absPath.toLowerCase() : absPath;
              if (wsLogicalForm && isSameOrInsideAnyDir([absForm], [wsLogicalForm])) {
                return absPath;
              }
              const realTarget = resolveRealPathBestEffort(absPath);
              return realTarget || absPath;
            });
          if (checkpointPaths.length > 0) {
            const realCwd = resolveRealPathBestEffort(cwd) || cwd;
            store.recordModifiedFiles(sessionId, checkpointPaths, {
              worktree: wsLogicalForm ? cwd : realCwd,
              tool: toolName
            });
          }
        }
      }
      if (verifySignal) {
        const safeCommand = redactSecrets(verifySignal.command || "").text;
        const safeSummary = redactSecrets(verifySignal.summary || "").text;
        store.recordVerificationResult(sessionId, {
          ...verifySignal,
          command: safeCommand,
          summary: safeSummary,
          worktree: cwd
        });
      }
      if (
        shouldTouchWatchdog &&
        watchdogLeaseMod?.recordHookLeaseTransition &&
        (typeof store.isWatchdogEnabled !== "function" || store.isWatchdogEnabled())
      ) {
        try {
          watchdogLeaseMod.recordHookLeaseTransition(store, "PostToolUse", payload, {
            directConvId,
            rootSessionId: sessionId,
            cwd,
            toolName,
            toolArgs: args,
            responseText,
            asyncBypassMs: effectiveCfg.cliFilterAsyncBypassMs ?? 2000
          });
        } catch {}
      }
    } catch {
      // Fail-open: never block PostToolUse
    } finally {
      if (store) {
        try {
          store.close();
        } catch {}
      }
    }
  }

  process.stdout.write("{}\n");
}

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
function isSameFilePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    const resolved = path.resolve(p);
    let real = resolved;
    try {
      real = fs.realpathSync(resolved);
    } catch {}
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
}
const isDirectRun = Boolean(process.argv[1] && isSameFilePath(process.argv[1], __selfPath));
if (isDirectRun) {
  main().catch(() => {
    process.stdout.write("{}\n");
  });
}
