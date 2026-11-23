import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeToolCall } from "../context/lib/cache-analyzer.js";
import { executeCode, inferLanguageFromFile, normalizeExecArgs } from "../context/lib/executor.js";
import { ContextModeStore } from "../context/lib/store.js";
import { createTools } from "../context/lib/tools.js";
import { classifyToolExecutionKind } from "../context/lib/watchdog-lease.js";
import {
  extractInvalidationTargets,
  isAntigravityBrainPathOutsideWorkspace,
  isEphemeralOsTempPathOutsideWorkspace,
  isEphemeralScratchOrTempPathOutsideWorkspace
} from "../hooks/post-tool-use.mjs";
import { auditPrefixBudget } from "../scripts/prefix-budget.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function createMcpClient(scriptPath, { env = {} } = {}) {
  const child = spawn(process.execPath, [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ...env }
  });
  let buf = "";
  let stderr = "";
  let nextId = 1;
  const pending = new Map();

  child.stderr.on("data", (d) => {
    stderr += d.toString("utf8");
  });
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed && parsed.id !== undefined && pending.has(parsed.id)) {
        const resolve = pending.get(parsed.id);
        pending.delete(parsed.id);
        resolve(parsed);
      }
    }
  });

  return {
    getStderr: () => stderr,
    request(method, params = {}, timeoutMs = 10000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP ${method} timed out (${stderr})`));
        }, timeoutMs);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.stdin.end();
      } catch {}
      await new Promise((r) => {
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {}
          r();
        }, 1000);
        child.once("close", () => {
          clearTimeout(timer);
          r();
        });
      });
    }
  };
}

test("ctx_execute resolves silent summary/description aliases, whitespace fallbacks, and FTS5 labels cleanly", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ctx-compact-unit-"));
  const store = new ContextModeStore({ dbPath: path.join(tmpDir, "ctx.db") });
  try {
    const tools = createTools({
      store,
      getCwd: () => tmpDir,
      getSessionId: () => "compact-session"
    });

    // 1. summary alias fallback + FTS5 source label
    const resSummary = await tools.ctx_execute({
      language: "javascript",
      code: "console.log('summary-payload-alpha');",
      summary: "  Short summary alias  "
    });
    assert.equal(resSummary.ok, true);
    assert.equal(resSummary.intent, "Short summary alias");
    const searchSummary = store.search({
      queries: ["summary-payload-alpha"],
      sourceId: resSummary.sourceId,
      sessionId: "compact-session",
      limit: 1
    });
    assert.equal(searchSummary.hits[0]?.title, "Short summary alias");

    // 2. description alias fallback
    const resDesc = await tools.ctx_execute({
      language: "javascript",
      code: "console.log('desc-ok');",
      description: "Short description alias"
    });
    assert.equal(resDesc.ok, true);
    assert.equal(resDesc.intent, "Short description alias");

    // 3. Canonical intent takes precedence over summary & description
    const resPrecedence = await tools.ctx_execute({
      language: "javascript",
      code: "console.log('prec-ok');",
      intent: "Canonical intent",
      summary: "Ignored summary",
      description: "Ignored description"
    });
    assert.equal(resPrecedence.ok, true);
    assert.equal(resPrecedence.intent, "Canonical intent");

    // 4. Whitespace-only intent falls through to summary, and non-string garbage is ignored safely
    const resBlankIntent = await tools.ctx_execute({
      language: "javascript",
      code: "console.log('blank-intent-ok');",
      intent: "   \t  ",
      summary: { bad: true },
      description: "Fallback after blank intent"
    });
    assert.equal(resBlankIntent.ok, true);
    assert.equal(resBlankIntent.intent, "Fallback after blank intent");

    // 5. All blank / non-string -> intent: null
    const resNullIntent = await tools.ctx_execute({
      language: "javascript",
      code: "console.log('no-intent');",
      intent: "  ",
      summary: 42,
      description: false
    });
    assert.equal(resNullIntent.ok, true);
    assert.equal(resNullIntent.intent, null);

    // 6. Oversized multi-KB description alias is capped to <= 240 UTF-8 bytes so MCP JSON stays <= 8.8 KB without starving output
    const resHugeDesc = await tools.ctx_execute({
      language: "javascript",
      code: "console.log('preserved-output-body');",
      description: "测".repeat(4000)
    });
    assert.equal(resHugeDesc.ok, true);
    assert.ok(Buffer.byteLength(resHugeDesc.intent, "utf8") <= 240);
    assert.equal(resHugeDesc.intent.includes("\uFFFD"), false);
    assert.match(resHugeDesc.output, /preserved-output-body/);
    assert.ok(Buffer.byteLength(JSON.stringify(resHugeDesc, null, 2), "utf8") <= 8800);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("ctx_execute executes OS temp-dir scripts via file + args ($TMPDIR/%TEMP%/file://), infers omitted language, and enforces sensitiveFileGuard", async () => {
  assert.equal(inferLanguageFromFile("/tmp/filter.py"), "python");
  assert.equal(inferLanguageFromFile("C:\\Temp\\parse.mjs"), "javascript");
  assert.equal(inferLanguageFromFile("/tmp/analyze.ts"), "javascript");
  assert.equal(inferLanguageFromFile("/tmp/check.ps1"), "powershell");
  assert.equal(inferLanguageFromFile("/tmp/run.sh"), "shell");
  assert.equal(inferLanguageFromFile(""), "");

  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ctx-ws-"));
  const scratchSubdir = `agy-ctx-scratch-${process.pid}-${Date.now()}`;
  const scratchAbsDir = path.join(os.tmpdir(), scratchSubdir);
  fs.mkdirSync(scratchAbsDir, { recursive: true });
  const store = new ContextModeStore({ dbPath: path.join(wsDir, "ctx.db") });

  try {
    const tools = createTools({
      store,
      getCwd: () => wsDir,
      getSessionId: () => "temp-file-session"
    });

    // ESM .mjs script placed in OS temp dir (outside workspace, no package.json needed)
    const mjsPath = path.join(scratchAbsDir, "analyze_trace.mjs");
    fs.writeFileSync(
      mjsPath,
      [
        'import path from "node:path";',
        "const args = process.argv.slice(2);",
        "console.log(JSON.stringify({ cwdBase: path.basename(process.cwd()), args }));"
      ].join("\n"),
      "utf8"
    );

    // 1. Omitted language auto-infers javascript from .mjs + $TMPDIR expansion (even if non-empty comment code is supplied)
    const resTmpEnv = await tools.ctx_execute({
      intent: "Analyze trace via $TMPDIR",
      file: `$TMPDIR/${scratchSubdir}/analyze_trace.mjs`,
      code: "// file takes precedence over inline comment",
      args: ["alpha beta", "gamma&delta"]
    });
    assert.equal(resTmpEnv.ok, true, resTmpEnv.output);
    assert.equal(resTmpEnv.language, "javascript");
    assert.equal(resTmpEnv.intent, "Analyze trace via $TMPDIR");
    assert.deepEqual(JSON.parse(resTmpEnv.output.trim()), {
      cwdBase: path.basename(wsDir),
      args: ["alpha beta", "gamma&delta"]
    });

    // 2. Windows %TEMP%, $env:TEMP, ${env:TEMP}, outer-quoted path & file:// URI script support
    for (const fileRef of [
      `%TEMP%\\${scratchSubdir}\\analyze_trace.mjs`,
      `$env:TEMP/${scratchSubdir}/analyze_trace.mjs`,
      `\${env:TEMP}/${scratchSubdir}/analyze_trace.mjs`,
      `"$TMPDIR/${scratchSubdir}/analyze_trace.mjs"`,
      pathToFileURL(mjsPath).href
    ]) {
      const resRef = await tools.ctx_execute({
        intent: "Analyze via temp ref",
        language: "javascript",
        file: fileRef,
        args: ["ok"]
      });
      assert.equal(resRef.ok, true, `Failed for ${fileRef}: ${resRef.output}`);
      assert.deepEqual(JSON.parse(resRef.output.trim()).args, ["ok"]);
    }

    // 2b. Whitespace-only file falls back cleanly to inline code, stringified/scalar args coerce cleanly,
    //     null code does not crash spawn, and real .ts scripts execute end-to-end
    assert.deepEqual(normalizeExecArgs('["alpha beta", "gamma&delta"]'), ["alpha beta", "gamma&delta"]);
    assert.deepEqual(normalizeExecArgs("trace.json"), ["trace.json"]);
    assert.deepEqual(normalizeExecArgs("   "), []);

    const resStringifiedArgs = await tools.ctx_execute({
      intent: "Analyze via JSON-stringified args array",
      file: mjsPath,
      args: '["alpha beta", "gamma&delta"]'
    });
    assert.equal(resStringifiedArgs.ok, true, resStringifiedArgs.output);
    assert.deepEqual(JSON.parse(resStringifiedArgs.output.trim()).args, ["alpha beta", "gamma&delta"]);

    const tsPath = path.join(scratchAbsDir, "analyze_typed.ts");
    fs.writeFileSync(
      tsPath,
      [
        "function total(values: number[]): number { return values.reduce((a, b) => a + b, 0); }",
        "const nums: number[] = process.argv.slice(2).map(Number);",
        "console.log(JSON.stringify({ typedSum: total(nums) }));"
      ].join("\n"),
      "utf8"
    );
    const resTsFile = await tools.ctx_execute({
      intent: "Execute TypeScript temp script with auto-inferred language",
      file: tsPath,
      args: ["11", "31"]
    });
    assert.equal(resTsFile.ok, true, resTsFile.output);
    assert.equal(resTsFile.language, "javascript");
    assert.deepEqual(JSON.parse(resTsFile.output.trim()), { typedSum: 42 });

    const wsFileFallback = await executeCode({
      language: "javascript",
      file: "   ",
      code: 'console.log("inline-ok");',
      cwd: wsDir
    });
    assert.equal(wsFileFallback.ok, true);
    assert.equal(wsFileFallback.stdout.trim(), "inline-ok");

    const inlineArgsJs = await executeCode({
      language: "javascript",
      code: "console.log(JSON.stringify(process.argv.slice(2)));",
      args: '["trace.json", "--limit=5"]',
      cwd: wsDir
    });
    assert.equal(inlineArgsJs.ok, true);
    assert.deepEqual(JSON.parse(inlineArgsJs.stdout.trim()), ["trace.json", "--limit=5"]);

    const nullJsCode = await executeCode({ language: "javascript", code: null, cwd: wsDir });
    assert.equal(nullJsCode.ok, true);

    // 2c. Windows PowerShell BOM-less UTF-8 .ps1 file & param(...) code preserve CJK matching, UTF-8 stdout, and exit codes
    if (process.platform === "win32") {
      const utf8LogPath = path.join(scratchAbsDir, "utf8-trace.log");
      const bomlessPs1Path = path.join(scratchAbsDir, "filter-utf8.ps1");
      fs.writeFileSync(utf8LogPath, "INFO: ok\nERROR: 数据库连接超时 — 请重试\n", "utf8");
      fs.writeFileSync(
        bomlessPs1Path,
        [
          "param([string]$LogPath)",
          'Get-Content -LiteralPath $LogPath -Encoding UTF8 | Where-Object { $_ -match "超时" }'
        ].join("\n"),
        "utf8"
      );
      const resPsFile = await tools.ctx_execute({
        intent: "Filter UTF-8 log via BOM-less PowerShell temp script",
        file: bomlessPs1Path,
        args: [utf8LogPath]
      });
      assert.equal(resPsFile.ok, true, resPsFile.output);
      assert.equal(resPsFile.language, "powershell");
      assert.equal(resPsFile.output.includes("\uFFFD"), false);
      assert.match(resPsFile.output, /ERROR: 数据库连接超时 — 请重试/);

      const resPsParamCode = await executeCode({
        language: "powershell",
        code: 'param([string]$Tag)\nWrite-Output "${Tag}:中文参数输出正常"\nexit 9',
        args: ["前缀"],
        cwd: wsDir
      });
      assert.equal(resPsParamCode.exitCode, 9);
      assert.equal(resPsParamCode.stdout.includes("\uFFFD"), false);
      assert.match(resPsParamCode.stdout, /前缀:中文参数输出正常/);
    }

    // 2d. PostToolUse excludes OS temp scripts outside workspace from sessionCheckpoint.modifiedFiles while keeping workspace edits
    assert.equal(isEphemeralOsTempPathOutsideWorkspace(mjsPath, wsDir), true);
    assert.equal(isEphemeralOsTempPathOutsideWorkspace(path.join(wsDir, "src", "app.js"), wsDir), false);
    const dbFile = path.join(wsDir, "ctx.db");
    const runPostHook = (targetPath) =>
      spawnSync(process.execPath, [path.join(ROOT, "hooks", "post-tool-use.mjs")], {
        input: JSON.stringify({
          conversationId: "temp-file-session",
          cwd: wsDir,
          toolCall: { name: "write_file", args: { Path: targetPath } },
          toolResponse: "Wrote file"
        }),
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: dbFile, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
      });
    assert.equal(runPostHook(mjsPath).status, 0);
    assert.deepEqual(store.getSessionCheckpoint("temp-file-session").modifiedFiles, []);
    const wsSrcFile = path.join(wsDir, "src", "app.js");
    assert.equal(runPostHook(wsSrcFile).status, 0);
    assert.deepEqual(store.getSessionCheckpoint("temp-file-session").modifiedFiles, ["src/app.js"]);

    // 2e. Antigravity brain/<conversation-id>/ (scratch/ & artifacts) paths outside workspace:
    //     - execute cleanly via ctx_execute(file + args)
    //     - invalidate file_reads in PostToolUse when edited
    //     - stay excluded from sessionCheckpoint.modifiedFiles without false-positiving sibling brain/ source dirs
    const sampleConvUuid = "cc6fe4a4-5def-403f-9efe-9245d41e852c";
    const fakeBrainAppRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ctx-brain-exec-"));
    try {
      const brainScratchDir = path.join(fakeBrainAppRoot, "antigravity", "brain", sampleConvUuid, "scratch");
      fs.mkdirSync(brainScratchDir, { recursive: true });
      const brainScriptPath = path.join(brainScratchDir, "filter_slow.mjs");
      fs.writeFileSync(
        brainScriptPath,
        'console.log(JSON.stringify({ source: "brain-scratch", args: process.argv.slice(2) }));\n',
        "utf8"
      );
      const resBrainExec = await tools.ctx_execute({
        intent: "Run script from Antigravity conversation scratch dir",
        file: brainScriptPath,
        args: ["trace.json", "--limit=5"]
      });
      assert.equal(resBrainExec.ok, true, resBrainExec.output);
      assert.equal(resBrainExec.language, "javascript");
      assert.deepEqual(JSON.parse(resBrainExec.output.trim()), {
        source: "brain-scratch",
        args: ["trace.json", "--limit=5"]
      });
    } finally {
      fs.rmSync(fakeBrainAppRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }

    const fsRoot = path.parse(wsDir).root;
    const nonTempHomeScratch = path.join(
      os.homedir(),
      ".gemini",
      "antigravity",
      "brain",
      sampleConvUuid,
      "scratch",
      "agy_ctx_trace.py"
    );
    const nonTempHomeArtifact = path.join(
      os.homedir(),
      ".gemini",
      "antigravity",
      "brain",
      sampleConvUuid,
      "implementation_plan.md"
    );
    const nonTempIdeScratch = path.join(
      fsRoot,
      "agy-non-temp-host",
      ".gemini",
      "antigravity-ide",
      "brain",
      "conv-ide-session",
      "scratch",
      "parse.mjs"
    );
    const nonTempT3Scratch = path.join(
      fsRoot,
      "agy-non-temp-host",
      ".t3",
      "userdata",
      "providers",
      "antigravity",
      "default",
      "brain",
      "conv-t3-session",
      "walkthrough.md"
    );
    const nonTempCustomUuidBrain = path.join(
      fsRoot,
      "agy-custom-appdata",
      "brain",
      sampleConvUuid,
      "scratch",
      "query.py"
    );
    const nonTempCustomConvBrain = path.join(
      fsRoot,
      "agy-custom-appdata",
      "brain",
      "temp-file-session",
      "scratch",
      "helper.mjs"
    );
    const nonTempCustomTxBrain = path.join(
      fsRoot,
      "agy-tx-appdata",
      "brain",
      "tx-derived-conv",
      "task.md"
    );
    const nonTempBrainUserPath = path.join(
      fsRoot,
      "Users",
      "brain",
      ".gemini",
      "antigravity",
      "brain",
      sampleConvUuid,
      "scratch",
      "nested.py"
    );
    const nonTempSiblingRepoBrain = path.join(
      fsRoot,
      "agy-sibling-repo",
      "src",
      "brain",
      "router",
      "index.js"
    );
    const nonTempEscapedTraversal = path.join(
      fsRoot,
      "agy-non-temp-host",
      ".gemini",
      "antigravity",
      "brain",
      sampleConvUuid,
      "..",
      "..",
      "..",
      "..",
      "real-repo",
      "index.js"
    );
    const bareBrainDir = path.join(os.homedir(), ".gemini", "antigravity", "brain");
    const bareConvBrainDir = path.join(os.homedir(), ".gemini", "antigravity", "brain", sampleConvUuid);
    const insideWsBrainFixture = path.join(
      wsDir,
      ".gemini",
      "antigravity",
      "brain",
      sampleConvUuid,
      "fixture.js"
    );

    // Prove non-temp paths are caught specifically by Antigravity brain detection (not OS temp dir)
    assert.equal(isEphemeralOsTempPathOutsideWorkspace(nonTempCustomUuidBrain, wsDir), false);
    assert.equal(isAntigravityBrainPathOutsideWorkspace(nonTempHomeScratch, wsDir), true);
    assert.equal(isAntigravityBrainPathOutsideWorkspace(nonTempHomeArtifact, wsDir), true);
    assert.equal(isAntigravityBrainPathOutsideWorkspace(nonTempIdeScratch, wsDir), true);
    assert.equal(isAntigravityBrainPathOutsideWorkspace(nonTempT3Scratch, wsDir), true);
    assert.equal(isAntigravityBrainPathOutsideWorkspace(nonTempCustomUuidBrain, wsDir), true);
    assert.equal(
      isAntigravityBrainPathOutsideWorkspace(nonTempCustomConvBrain, wsDir, {
        conversationIds: ["temp-file-session"]
      }),
      true
    );
    assert.equal(
      isAntigravityBrainPathOutsideWorkspace(nonTempCustomTxBrain, wsDir, {
        transcriptPath: path.join(
          fsRoot,
          "agy-tx-appdata",
          "brain",
          "tx-derived-conv",
          ".system_generated",
          "logs",
          "transcript.jsonl"
        )
      }),
      true
    );
    assert.equal(isAntigravityBrainPathOutsideWorkspace(nonTempBrainUserPath, wsDir), true);
    assert.equal(isEphemeralScratchOrTempPathOutsideWorkspace(nonTempHomeScratch, wsDir), true);

    // Negative / boundary guards
    assert.equal(isAntigravityBrainPathOutsideWorkspace(nonTempSiblingRepoBrain, wsDir), false);
    assert.equal(isEphemeralScratchOrTempPathOutsideWorkspace(nonTempSiblingRepoBrain, wsDir), false);
    assert.equal(isAntigravityBrainPathOutsideWorkspace(nonTempEscapedTraversal, wsDir), false);
    assert.equal(isAntigravityBrainPathOutsideWorkspace(bareBrainDir, wsDir), false);
    assert.equal(isAntigravityBrainPathOutsideWorkspace(bareConvBrainDir, wsDir), false);
    assert.equal(isAntigravityBrainPathOutsideWorkspace(insideWsBrainFixture, wsDir), false);
    assert.equal(isAntigravityBrainPathOutsideWorkspace("src/app.js", wsDir), false);
    assert.equal(isAntigravityBrainPathOutsideWorkspace("   ", wsDir), false);

    // Subprocess PostToolUse: invalidates file_reads on brain scratch & artifact edits while keeping modifiedFiles clean
    for (const trackedBrainTarget of [nonTempHomeScratch, nonTempHomeArtifact, nonTempCustomConvBrain]) {
      store.recordFileRead({
        sessionId: "temp-file-session",
        filePath: trackedBrainTarget,
        startLine: 1,
        endLine: null,
        mtimeMs: 1700000000000,
        fileSize: 512,
        byteEst: 512
      });
      assert.ok(
        store.findDuplicateRead({
          sessionId: "temp-file-session",
          filePath: trackedBrainTarget,
          startLine: 1,
          endLine: null,
          mtimeMs: 1700000000000,
          fileSize: 512
        }),
        `Expected seeded file_reads hit before PostToolUse for ${trackedBrainTarget}`
      );
      assert.equal(runPostHook(trackedBrainTarget).status, 0);
      assert.equal(
        store.findDuplicateRead({
          sessionId: "temp-file-session",
          filePath: trackedBrainTarget,
          startLine: 1,
          endLine: null,
          mtimeMs: 1700000000000,
          fileSize: 512
        }),
        null,
        `Expected PostToolUse to invalidate file_reads for ${trackedBrainTarget}`
      );
    }
    assert.deepEqual(store.getSessionCheckpoint("temp-file-session").modifiedFiles, ["src/app.js"]);

    // 2f. Windows PowerShell BOM-less UTF-8 .ps1 inside brain/<convId>/scratch/ preserves $PSScriptRoot + CJK UTF-8
    if (process.platform === "win32") {
      const psBrainRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ctx-ps-brain-"));
      try {
        const psBrainScratch = path.join(psBrainRoot, ".gemini", "antigravity", "brain", sampleConvUuid, "scratch");
        fs.mkdirSync(psBrainScratch, { recursive: true });
        fs.writeFileSync(path.join(psBrainScratch, "sibling.txt"), "兄弟节点配置正常\n", "utf8");
        const psBrainScript = path.join(psBrainScratch, "read_sibling.ps1");
        fs.writeFileSync(
          psBrainScript,
          [
            "# 中文注释触发 UTF-8 BOM 暂存",
            '$sib = Join-Path $PSScriptRoot "sibling.txt"',
            "Get-Content -LiteralPath $sib -Encoding UTF8"
          ].join("\n"),
          "utf8"
        );
        const resBrainPs = await tools.ctx_execute({
          intent: "Verify $PSScriptRoot inside brain scratch dir",
          file: psBrainScript
        });
        assert.equal(resBrainPs.ok, true, resBrainPs.output);
        assert.match(resBrainPs.output, /兄弟节点配置正常/);
      } finally {
        fs.rmSync(psBrainRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    }

    // 2g. PostToolUse tilde (`~/...`) & `default_api:` namespace expansion + Cross-OS Linux/Win32 simulation + Symlink/Junction escape protection
    const tildeBrainRel = `~/.gemini/antigravity/brain/${sampleConvUuid}/scratch/tilde_probe.py`;
    const tildeTargets = extractInvalidationTargets(
      "default_api:apply_edits",
      { edits: [{ path: tildeBrainRel }] },
      wsDir
    );
    assert.equal(tildeTargets.paths.length, 1);
    assert.equal(tildeTargets.paths[0], nonTempHomeScratch.replace(/agy_ctx_trace\.py$/, "tilde_probe.py"));
    assert.equal(
      spawnSync(process.execPath, [path.join(ROOT, "hooks", "post-tool-use.mjs")], {
        input: JSON.stringify({
          conversationId: "temp-file-session",
          cwd: wsDir,
          toolCall: {
            name: "default_api:apply_edits",
            args: { edits: [{ path: tildeBrainRel }] }
          },
          toolResponse: "Applied edits to 1 file(s):\n- ~/.gemini/antigravity/brain/" + sampleConvUuid + "/scratch/tilde_probe.py: created"
        }),
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: dbFile, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
      }).status,
      0
    );
    assert.deepEqual(store.getSessionCheckpoint("temp-file-session").modifiedFiles, ["src/app.js"]);

    // Cross-OS POSIX (`platform: "linux"`) verification for Windows-drive traversal, case-insensitivity, and POSIX brain/temp paths
    assert.equal(
      isAntigravityBrainPathOutsideWorkspace(
        `C:\\Users\\Alice\\.gemini\\antigravity\\brain\\${sampleConvUuid}\\..\\..\\..\\..\\real-repo\\index.js`,
        "/home/alice/ws",
        { platform: "linux" }
      ),
      false
    );
    assert.equal(
      isAntigravityBrainPathOutsideWorkspace(
        `C:\\Work\\Repo\\.gemini\\antigravity\\brain\\${sampleConvUuid}\\fixture.js`,
        "c:\\work\\repo",
        { platform: "linux" }
      ),
      false
    );
    assert.equal(
      isAntigravityBrainPathOutsideWorkspace(
        "C:\\CustomAg\\brain\\tx-win-conv\\scratch\\probe.py",
        "/home/alice/ws",
        {
          platform: "linux",
          transcriptPath: "c:\\customag\\brain\\tx-win-conv\\.system_generated\\logs\\transcript.jsonl"
        }
      ),
      true
    );
    assert.equal(
      isAntigravityBrainPathOutsideWorkspace(
        `/home/alice/.gemini/antigravity/brain/${sampleConvUuid}/scratch/agy_ctx_trace.py`,
        "/home/alice/repo",
        { platform: "linux" }
      ),
      true
    );
    assert.equal(
      isEphemeralOsTempPathOutsideWorkspace("/tmp/agy_ctx_trace.py", "/home/alice/repo", { platform: "linux" }),
      true
    );
    assert.equal(
      isAntigravityBrainPathOutsideWorkspace(
        "/home/alice/sibling-repo/src/brain/router/index.js",
        "/home/alice/repo",
        { platform: "linux", conversationIds: ["router"] }
      ),
      false
    );

    // Symlink / directory junction escape guard:
    // 1) A junction inside `brain/<uuid>/scratch/` (or OS temp) pointing to a real non-temp external repo MUST NOT be excluded
    //    from `modifiedFiles`, and PostToolUse invalidates `file_reads` on BOTH the symlink path and real target path.
    // 2) Conversely, a symlinked `.gemini` home pointing to a real `brain/<uuid>/scratch/` folder IS still recognized as ephemeral.
    const symlinkArena = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ctx-symlink-arena-"));
    const dirLinkType = process.platform === "win32" ? "junction" : "dir";
    try {
      const fakeDotfilesBrain = path.join(symlinkArena, "dotfiles-store", ".gemini", "antigravity", "brain", sampleConvUuid, "scratch");
      fs.mkdirSync(fakeDotfilesBrain, { recursive: true });
      fs.writeFileSync(path.join(fakeDotfilesBrain, "legit.py"), "print(1)\n", "utf8");
      const fakeUserHome = path.join(symlinkArena, "user-home");
      fs.mkdirSync(fakeUserHome, { recursive: true });
      fs.symlinkSync(path.join(symlinkArena, "dotfiles-store", ".gemini"), path.join(fakeUserHome, ".gemini"), dirLinkType);
      const viaDotfilesSymlink = path.join(fakeUserHome, ".gemini", "antigravity", "brain", sampleConvUuid, "scratch", "legit.py");
      assert.equal(isAntigravityBrainPathOutsideWorkspace(viaDotfilesSymlink, wsDir), true);

      const extRealRepoFile = path.join(ROOT, "package.json");
      const escapeScratchDir = path.join(symlinkArena, "host-app", ".gemini", "antigravity", "brain", sampleConvUuid, "scratch");
      fs.mkdirSync(escapeScratchDir, { recursive: true });
      const escapeJunction = path.join(escapeScratchDir, "escaped-repo");
      fs.symlinkSync(ROOT, escapeJunction, dirLinkType);
      const escapedViaBrainFile = path.join(escapeJunction, "package.json");

      assert.equal(isAntigravityBrainPathOutsideWorkspace(escapedViaBrainFile, wsDir), false);
      assert.equal(isEphemeralOsTempPathOutsideWorkspace(escapedViaBrainFile, wsDir), false);
      assert.equal(isEphemeralScratchOrTempPathOutsideWorkspace(escapedViaBrainFile, wsDir), false);

      store.recordFileRead({
        sessionId: "escape-link-session",
        filePath: extRealRepoFile,
        startLine: 1,
        endLine: null,
        mtimeMs: 1700000000000,
        fileSize: 512,
        byteEst: 512
      });
      assert.equal(
        spawnSync(process.execPath, [path.join(ROOT, "hooks", "post-tool-use.mjs")], {
          input: JSON.stringify({
            conversationId: "escape-link-session",
            cwd: wsDir,
            toolCall: { name: "write_file", args: { Path: escapedViaBrainFile } },
            toolResponse: "Wrote file"
          }),
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, AGY_DART_DB_PATH: dbFile, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
        }).status,
        0
      );
      assert.equal(
        store.findDuplicateRead({
          sessionId: "escape-link-session",
          filePath: extRealRepoFile,
          startLine: 1,
          endLine: null,
          mtimeMs: 1700000000000,
          fileSize: 512
        }),
        null,
        "Expected PostToolUse to invalidate canonical real target file_reads when edited through scratch symlink/junction"
      );
      const escapedModFiles = store.getSessionCheckpoint("escape-link-session").modifiedFiles;
      assert.equal(escapedModFiles.length, 1);
      assert.match(escapedModFiles[0], /package\.json$/);
    } finally {
      fs.rmSync(symlinkArena, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }

    // 3. sensitiveFileGuard=deny still blocks expanded temp/file:// paths pointing to .env
    const fakeEnvFile = path.join(scratchAbsDir, ".env");
    fs.writeFileSync(fakeEnvFile, "API_KEY=secret\n", "utf8");
    const prevGuard = process.env.AGY_DART_SENSITIVE_FILE_GUARD;
    process.env.AGY_DART_SENSITIVE_FILE_GUARD = "deny";
    try {
      await assert.rejects(
        () =>
          tools.ctx_execute({
            intent: "Attempt blocked env execution",
            language: "shell",
            file: `$TMPDIR/${scratchSubdir}/.env`
          }),
        /Blocked executing sensitive file/
      );
      await assert.rejects(
        () =>
          tools.ctx_execute({
            intent: "Attempt blocked file URI env execution",
            language: "shell",
            file: pathToFileURL(fakeEnvFile).href
          }),
        /Blocked executing sensitive file/
      );
    } finally {
      if (prevGuard === undefined) delete process.env.AGY_DART_SENSITIVE_FILE_GUARD;
      else process.env.AGY_DART_SENSITIVE_FILE_GUARD = prevGuard;
    }
  } finally {
    store.close();
    fs.rmSync(scratchAbsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(wsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("MCP stdio tools/call forwards silent aliases while tools/list, Watchdog, CacheAnalyzer, AGENTS.md, SKILL.md & prefix:budget stay aligned", async () => {
  // Watchdog & CacheAnalyzer pick up silent summary/description aliases across normal, JSON-quoted transcript, and eager MCP names
  const wdSummary = classifyToolExecutionKind("call_mcp_tool", {
    ServerName: '"agy-dart_context"',
    ToolName: '"ctx_execute"',
    Arguments: { summary: "Scan slow SQL", language: "python", file: "/tmp/scan.py" }
  });
  assert.equal(wdSummary.activeTool, "ctx_execute");
  assert.equal(wdSummary.activeToolKind, "mcp_long");
  assert.equal(wdSummary.summary, "Scan slow SQL");

  const wdDoubleUnderscore = classifyToolExecutionKind("mcp__agy-dart_context__ctx_execute", {
    description: "Inspect double-underscore MCP alias"
  });
  assert.equal(wdDoubleUnderscore.activeTool, "ctx_execute");
  assert.equal(wdDoubleUnderscore.activeToolKind, "mcp_long");
  assert.equal(wdDoubleUnderscore.summary, "Inspect double-underscore MCP alias");

  const caDesc = describeToolCall({
    name: "call_mcp_tool",
    args: {
      ServerName: '"agy-dart_context"',
      ToolName: '"ctx_execute"',
      Arguments: { description: "Parse huge CSV", file: "/tmp/csv.py" }
    }
  });
  assert.match(caDesc.label, /Parse huge CSV/);

  const caEager = describeToolCall({
    name: "mcp_agy-dart_context_ctx_execute",
    args: { summary: "Eager ctx_execute summary", file: "/tmp/csv.py" }
  });
  assert.match(caEager.label, /Eager ctx_execute summary/);

  // Live MCP server handshake & tools/call verification
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ctx-mcp-compact-"));
  const scriptFile = path.join(tmpDir, "sum_args.mjs");
  fs.writeFileSync(
    scriptFile,
    'console.log(JSON.stringify({ sum: process.argv.slice(2).map(Number).reduce((a, b) => a + b, 0) }));\n',
    "utf8"
  );

  const client = createMcpClient(path.join(ROOT, "context", "server.js"), {
    env: { AGY_DART_DB_PATH: path.join(tmpDir, "ctx.db") }
  });
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      rootUri: pathToFileURL(tmpDir).href
    });

    const listResp = await client.request("tools/list", {});
    const ctxExecDef = listResp.result.tools.find((t) => t.name === "ctx_execute");
    assert.ok(ctxExecDef, "ctx_execute must exist in tools/list");
    assert.equal(ctxExecDef.inputSchema.properties.intent.type, "string");
    // Silent aliases must NOT bloat advertised inputSchema
    assert.equal(ctxExecDef.inputSchema.properties.summary, undefined);
    assert.equal(ctxExecDef.inputSchema.properties.description, undefined);
    assert.match(ctxExecDef.description, /intent first/i);
    assert.match(ctxExecDef.description, /scratch dir \(or OS temp\)/i);
    assert.match(ctxExecDef.description, /file \+ args/i);

    const callResp = await client.request("tools/call", {
      name: "ctx_execute",
      arguments: {
        summary: "Sum numeric args via MCP stdio",
        file: scriptFile,
        args: ["10", "25", "7"]
      }
    });
    assert.equal(callResp.result.isError, false, callResp.result.content?.[0]?.text);
    const payload = JSON.parse(callResp.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.language, "javascript");
    assert.equal(payload.intent, "Sum numeric args via MCP stdio");
    assert.deepEqual(JSON.parse(payload.output.trim()), { sum: 42 });
    assert.equal(client.getStderr(), "");
  } finally {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  // Rule & Skill alignment + Turn-0 prefix budget gate
  const agentsMd = fs.readFileSync(path.join(ROOT, "rules", "AGENTS.md"), "utf8");
  const skillMd = fs.readFileSync(path.join(ROOT, "skills", "agy-dart", "SKILL.md"), "utf8");

  assert.match(agentsMd, /- `ctx_execute`: `\{\s*intent\?,/);
  assert.match(agentsMd, /<=5 lines/i);
  assert.match(agentsMd, /<Artifact Directory Path>\/scratch\/\.\.\./);
  assert.match(agentsMd, /<appDataDir>\/brain\/<conversation-id>\/scratch\/\.\.\./);
  assert.match(agentsMd, /`file` \+ `args`/);
  assert.equal(/`summary`|`description`/i.test(skillMd), false);
  assert.match(skillMd, /"intent": "Analyze slow queries in trace\.json"/);
  assert.match(skillMd, /<Artifact Directory Path>\/scratch\/agy_ctx_trace\.py/);
  assert.match(skillMd, /<appDataDir>\/brain\/<conversation-id>\/scratch\/agy_ctx_trace\.py/);
  assert.match(skillMd, /"file": "\/home\/<user>\/\.gemini\/antigravity\/brain\/<conversation-id>\/scratch\/agy_ctx_trace\.py"/);
  assert.match(skillMd, /"file": "\/tmp\/agy_ctx_trace\.py"/);

  const budget = await auditPrefixBudget(ROOT);
  assert.equal(budget.exceedsBudget, false);
  assert.equal(budget.exceedsUpperBound, false);
  assert.equal(budget.blocks.tools.canonical, true);
  assert.ok(budget.totalTokens < 3150, `Expected Turn-0 tokens < 3150, got ${budget.totalTokens}`);
});
