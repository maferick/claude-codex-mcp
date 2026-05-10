#!/usr/bin/env node

import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
const MODES = {
  review:
    "You are reviewing the included material for bugs, edge cases, and detail issues. Be terse. Cite file:line. Don't restate what the code does.",
  plan:
    "You are proposing an implementation approach. Be concrete about steps, files affected, and tradeoffs. Don't write the code.",
  debug:
    "You are debugging. Form hypotheses, suggest checks, identify likely root cause. Don't fix yet.",
  ux:
    "You are reviewing user-facing behavior. Focus on user-visible issues, naming, error messages, and edge interactions.",
  architecture:
    "Sanity-check an architectural choice. Surface load-bearing assumptions and failure modes.",
};

const DEFAULTS = {
  timeoutMs: 300000,
  maxFileBytes: 262144,
  maxPromptBytes: 1048576,
  maxResponseBytes: 262144,
  codexCmd: "codex exec -",
  claudeCmd: "claude -p",
};

let clientInfo = null;
let clientRoots = [];
let buffer = "";
let messageQueue = Promise.resolve();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line) {
      messageQueue = messageQueue.then(() => handleLine(line)).catch((error) => {
        writeLog(`fatal handler error: ${formatError(error)}\n`);
      });
    }
  }
});

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    return sendError(null, -32700, "Parse error", formatError(error));
  }

  if (!message || typeof message !== "object") {
    return sendError(null, -32600, "Invalid Request");
  }

  if (!Object.hasOwn(message, "id")) {
    await handleNotification(message);
    return;
  }

  try {
    const result = await handleRequest(message);
    send({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    sendError(message.id, Number.isInteger(error.code) ? error.code : -32000, error.message ?? "Internal error", error.data);
  }
}

async function handleNotification(message) {
  if (message.method === "notifications/initialized") {
    return;
  }
}

async function handleRequest(message) {
  switch (message.method) {
    case "initialize":
      clientInfo = message.params?.clientInfo ?? null;
      clientRoots = normalizeRoots(message.params?.roots ?? []);
      return {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-collab-mcp", version: VERSION },
      };
    case "tools/list":
      return { tools: toolDefinitions() };
    case "tools/call":
      return callTool(message.params);
    case "ping":
      return {};
    default:
      throw rpcError(-32601, `Method not found: ${message.method}`);
  }
}

async function callTool(params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  let result;

  switch (name) {
    case "consult":
      result = await consult(args);
      break;
    case "post_handoff":
      result = await postHandoff(args);
      break;
    case "get_context":
      result = await getContext(args);
      break;
    case "record_decision":
      result = await recordDecision(args);
      break;
    default:
      throw rpcError(-32602, `Unknown tool: ${name}`);
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

async function consult(args) {
  assertString(args.question, "question");
  const mode = optionalEnum(args.mode, "mode", Object.keys(MODES));
  const files = optionalStringArray(args.files, "files");
  const includeGitDiff = Boolean(args.include_git_diff);
  const root = await resolveProjectRoot();
  const caller = resolveCaller();
  const target = resolveTarget(args.target, caller);
  const id = randomUUID();
  const started = Date.now();
  const settings = readSettings();

  let prompt;
  let response = "";
  let truncated = false;
  let errorText;
  let stderrTail;
  let latencyMs;

  try {
    prompt = await assemblePrompt({ root, question: args.question, files, includeGitDiff, mode, settings });
    const subprocess = await runTarget(target, prompt, settings, root);
    response = truncateUtf8(subprocess.stdout, settings.maxResponseBytes);
    truncated = Buffer.byteLength(subprocess.stdout, "utf8") > settings.maxResponseBytes;
    stderrTail = subprocess.stderr ? tailBytes(subprocess.stderr, 4096) : undefined;
    latencyMs = Date.now() - started;

    if (subprocess.error) {
      errorText = subprocess.error;
      return {
        consult_id: id,
        error: subprocess.error,
        stderr_tail: stderrTail,
        latency_ms: latencyMs,
        truncated,
      };
    }

    return { consult_id: id, response, latency_ms: latencyMs, truncated };
  } catch (error) {
    errorText = error.message ?? formatError(error);
    throw error;
  } finally {
    latencyMs ??= Date.now() - started;
    await appendEventSafe(root, {
      id,
      type: "consult",
      timestamp: new Date().toISOString(),
      caller,
      target,
      ...(mode ? { mode } : {}),
      question: args.question,
      ...(mode ? { prompt_prefix: MODES[mode] } : {}),
      files,
      include_git_diff: includeGitDiff,
      response,
      latency_ms: latencyMs,
      truncated,
      ...(stderrTail ? { stderr_tail: stderrTail } : {}),
      ...(errorText ? { error: errorText } : {}),
    });
  }
}

async function postHandoff(args) {
  assertString(args.summary, "summary");
  const root = await resolveProjectRoot();
  const id = randomUUID();
  const event = {
    id,
    type: "handoff",
    timestamp: new Date().toISOString(),
    from: resolveCaller(),
    summary: args.summary,
    changed_files: optionalStringArray(args.changed_files, "changed_files"),
    open_questions: optionalStringArray(args.open_questions, "open_questions"),
    next_steps: optionalStringArray(args.next_steps, "next_steps"),
  };
  await appendEvent(root, event);
  return { handoff_id: id };
}

async function recordDecision(args) {
  assertString(args.text, "text");
  const root = await resolveProjectRoot();
  const id = randomUUID();
  const event = {
    id,
    type: "decision",
    timestamp: new Date().toISOString(),
    author: resolveCaller(),
    text: args.text,
    ...(typeof args.rationale === "string" ? { rationale: args.rationale } : {}),
    tags: optionalStringArray(args.tags, "tags"),
  };
  await appendEvent(root, event);
  return { decision_id: id };
}

async function getContext(args) {
  const root = await resolveProjectRoot();
  const limits = {
    handoffs: positiveInt(args.limit_handoffs, 5, "limit_handoffs"),
    decisions: positiveInt(args.limit_decisions, 20, "limit_decisions"),
    consults: positiveInt(args.limit_consults, 10, "limit_consults"),
  };
  const since = typeof args.since === "string" && args.since ? Date.parse(args.since) : null;
  if (since !== null && Number.isNaN(since)) {
    throw rpcError(-32602, "since must be an ISO timestamp or parseable date string");
  }

  const events = await readEvents(root);
  const result = { handoffs: [], decisions: [], consults: [] };

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (since !== null && Date.parse(event.timestamp) < since) {
      continue;
    }
    if (event.type === "handoff" && result.handoffs.length < limits.handoffs) {
      result.handoffs.push(pick(event, ["id", "timestamp", "from", "summary", "changed_files", "open_questions", "next_steps"]));
    }
    if (event.type === "decision" && result.decisions.length < limits.decisions) {
      result.decisions.push(pick(event, ["id", "timestamp", "author", "text", "rationale", "tags"]));
    }
    if (event.type === "consult" && result.consults.length < limits.consults) {
      result.consults.push({
        id: event.id,
        timestamp: event.timestamp,
        caller: event.caller,
        target: event.target,
        mode: event.mode,
        question_preview: String(event.question ?? "").slice(0, 200),
      });
    }
    if (
      result.handoffs.length >= limits.handoffs &&
      result.decisions.length >= limits.decisions &&
      result.consults.length >= limits.consults
    ) {
      break;
    }
  }

  return result;
}

async function assemblePrompt({ root, question, files, includeGitDiff, mode, settings }) {
  const parts = [];
  if (mode) {
    parts.push(MODES[mode]);
  }
  parts.push(question);

  for (const file of files) {
    const resolved = resolveInsideRoot(root, file);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw rpcError(-32602, `File not found: ${file}`);
    }
    if (stat.size > settings.maxFileBytes) {
      throw rpcError(-32602, `File too large: ${file} (${stat.size} bytes > ${settings.maxFileBytes})`);
    }
    const content = await fs.readFile(resolved, "utf8");
    parts.push(`--- ${path.relative(root, resolved)} ---\n${content}`);
  }

  if (includeGitDiff) {
    const diff = await runGitDiff(root);
    parts.push(`--- git diff ---\n${diff}`);
  }

  const prompt = parts.filter(Boolean).join("\n\n");
  const byteLength = Buffer.byteLength(prompt, "utf8");
  if (byteLength > settings.maxPromptBytes) {
    throw rpcError(-32602, `Prompt too large: ${byteLength} bytes > ${settings.maxPromptBytes}`);
  }
  return prompt;
}

function runGitDiff(root) {
  return new Promise((resolve) => {
    execFile("git", ["diff", "--no-ext-diff"], { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve(`[git diff failed]\n${stderr || error.message}`);
        return;
      }
      resolve(stdout);
    });
  });
}

async function runTarget(target, prompt, settings, root) {
  const command = target === "codex" ? settings.codexCmd : settings.claudeCmd;
  const [file, ...args] = splitCommand(command);
  if (!file) {
    return { stdout: "", stderr: "", error: `${target} command is empty` };
  }
  const commandSpec = platformCommand(file, args);

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let killedForTimeout = false;
    let child;

    try {
      child = spawn(commandSpec.file, commandSpec.args, {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: commandSpec.shell,
      });
    } catch (error) {
      resolve({ stdout: "", stderr: "", error: `${target} CLI not found on PATH; set AGENT_COLLAB_${target.toUpperCase()}_CMD` });
      return;
    }

    const timer = setTimeout(() => {
      killedForTimeout = true;
      terminateChild(child);
      setTimeout(() => {
        if (!settled) {
          terminateChild(child, true);
        }
      }, 5000).unref();
    }, settings.timeoutMs);
    timer.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {
      // The child may exit before reading stdin. Surface that through the
      // normal close/error path instead of crashing the MCP process on EPIPE.
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      settled = true;
      resolve({ stdout, stderr, error: `${target} CLI not found on PATH; set AGENT_COLLAB_${target.toUpperCase()}_CMD (${error.message})` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      settled = true;
      if (killedForTimeout) {
        resolve({ stdout, stderr, error: `${target} timed out after ${settings.timeoutMs}ms` });
      } else if (code !== 0 && looksLikeCommandNotFound(stderr)) {
        resolve({ stdout, stderr, error: `${target} CLI not found on PATH; set AGENT_COLLAB_${target.toUpperCase()}_CMD` });
      } else if (code !== 0) {
        resolve({ stdout, stderr, error: `${target} exited with code ${code}${signal ? ` signal ${signal}` : ""}` });
      } else {
        resolve({ stdout, stderr });
      }
    });

    child.stdin.end(prompt);
  });
}

async function appendEvent(root, event) {
  const dir = collabDir(root);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, "log.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

async function appendEventSafe(root, event) {
  try {
    await appendEvent(root, event);
  } catch (error) {
    writeLog(`agent-collab-mcp log write failed: ${formatError(error)}\n`);
  }
}

async function readEvents(root) {
  const logPath = path.join(collabDir(root), "log.jsonl");
  const text = await fs.readFile(logPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: "invalid", timestamp: "1970-01-01T00:00:00.000Z" };
      }
    });
}

async function resolveProjectRoot() {
  const explicit = process.env.AGENT_COLLAB_PROJECT_ROOT;
  if (explicit) {
    return path.resolve(explicit);
  }
  const rootFromClient = clientRoots.find((root) => root.startsWith("file://"));
  if (rootFromClient) {
    return fileURLToPath(rootFromClient);
  }
  return process.cwd();
}

function collabDir(root) {
  return process.env.AGENT_COLLAB_DIR ? path.resolve(process.env.AGENT_COLLAB_DIR) : path.join(root, ".agent-collab");
}

function normalizeRoots(roots) {
  if (!Array.isArray(roots)) {
    return [];
  }
  return roots.map((root) => root?.uri).filter((uri) => typeof uri === "string");
}

function resolveInsideRoot(root, inputPath) {
  if (typeof inputPath !== "string" || !inputPath) {
    throw rpcError(-32602, "files entries must be non-empty strings");
  }
  const resolved = path.resolve(root, inputPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw rpcError(-32602, `File outside project root: ${inputPath}`);
  }
  return resolved;
}

function resolveCaller() {
  const name = clientInfo?.name ?? "";
  if (/claude/i.test(name)) {
    return "claude";
  }
  if (/codex/i.test(name)) {
    return "codex";
  }
  const override = process.env.AGENT_COLLAB_CALLER;
  if (override === "claude" || override === "codex") {
    return override;
  }
  return "unknown";
}

function resolveTarget(explicitTarget, caller) {
  if (explicitTarget !== undefined) {
    return optionalEnum(explicitTarget, "target", ["codex", "claude"]);
  }
  if (caller === "claude") {
    return "codex";
  }
  if (caller === "codex") {
    return "claude";
  }
  throw rpcError(-32602, "target is required when caller cannot be auto-detected");
}

function readSettings() {
  return {
    timeoutMs: envInt("AGENT_COLLAB_TIMEOUT_MS", DEFAULTS.timeoutMs),
    maxFileBytes: envInt("AGENT_COLLAB_MAX_FILE_BYTES", DEFAULTS.maxFileBytes),
    maxPromptBytes: envInt("AGENT_COLLAB_MAX_PROMPT_BYTES", DEFAULTS.maxPromptBytes),
    maxResponseBytes: envInt("AGENT_COLLAB_MAX_RESPONSE_BYTES", DEFAULTS.maxResponseBytes),
    codexCmd: process.env.AGENT_COLLAB_CODEX_CMD || DEFAULTS.codexCmd,
    claudeCmd: process.env.AGENT_COLLAB_CLAUDE_CMD || DEFAULTS.claudeCmd,
  };
}

function splitCommand(command) {
  const parts = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return parts;
}

function platformCommand(file, args) {
  if (process.platform !== "win32") {
    return { file, args, shell: false };
  }
  return { file: [file, ...args].map(quoteCmdArg).join(" "), args: [], shell: true };
}

function terminateChild(child, force = false) {
  if (process.platform === "win32" && child.pid) {
    execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => {});
    return;
  }
  child.kill(force ? "SIGKILL" : "SIGTERM");
}

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function looksLikeCommandNotFound(stderr) {
  return process.platform === "win32" && /(is not recognized as|cannot find the path|command not found)/i.test(stderr ?? "");
}

function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
}

function tailBytes(text, maxBytes) {
  const buffer = Buffer.from(text ?? "", "utf8");
  return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf8");
}

function envInt(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInt(value, fallback, name) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw rpcError(-32602, `${name} must be a non-negative integer`);
  }
  return value;
}

function assertString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw rpcError(-32602, `${name} must be a non-empty string`);
  }
}

function optionalStringArray(value, name) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw rpcError(-32602, `${name} must be an array of strings`);
  }
  return value;
}

function optionalEnum(value, name, choices) {
  if (value === undefined) {
    return undefined;
  }
  if (!choices.includes(value)) {
    throw rpcError(-32602, `${name} must be one of: ${choices.join(", ")}`);
  }
  return value;
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]]));
}

function rpcError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  error.data = data;
  return error;
}

function formatError(error) {
  return error?.stack || error?.message || String(error);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(id, code, message, data) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

function writeLog(message) {
  process.stderr.write(message);
}

function toolDefinitions() {
  return [
    {
      name: "consult",
      description: "Ask the other agent for a synchronous one-shot consult using optional files and git diff.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          include_git_diff: { type: "boolean" },
          mode: { type: "string", enum: Object.keys(MODES) },
          target: { type: "string", enum: ["codex", "claude"] },
        },
        required: ["question"],
      },
    },
    {
      name: "post_handoff",
      description: "Leave a durable structured handoff note for the other agent.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          changed_files: { type: "array", items: { type: "string" } },
          open_questions: { type: "array", items: { type: "string" } },
          next_steps: { type: "array", items: { type: "string" } },
        },
        required: ["summary"],
      },
    },
    {
      name: "get_context",
      description: "Read recent shared handoffs, decisions, and consult metadata.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit_handoffs: { type: "integer", minimum: 0 },
          limit_decisions: { type: "integer", minimum: 0 },
          limit_consults: { type: "integer", minimum: 0 },
          since: { type: "string" },
        },
      },
    },
    {
      name: "record_decision",
      description: "Append a durable decision to the shared project log.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          rationale: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["text"],
      },
    },
  ];
}
