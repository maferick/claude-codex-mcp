import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const testRoot = path.join(repoRoot, ".error-tmp");
const serverPath = path.join(repoRoot, "src", "index.mjs");
const hangingAgentPath = path.join(testRoot, "hang-agent.mjs");
const exitAgentPath = path.join(testRoot, "exit-agent.mjs");

await fs.rm(testRoot, { recursive: true, force: true });
await fs.mkdir(testRoot, { recursive: true });
await fs.writeFile(path.join(testRoot, "sample.txt"), "hello\n", "utf8");
await fs.writeFile(hangingAgentPath, "setTimeout(() => {}, 10000);\n", "utf8");
await fs.writeFile(exitAgentPath, "process.exit(1);\n", "utf8");

async function callTool(arguments_, extraEnv = {}) {
  const child = spawn("node", [serverPath], {
    env: {
      ...process.env,
      AGENT_COLLAB_PROJECT_ROOT: testRoot,
      AGENT_COLLAB_CALLER: "codex",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", clientInfo: { name: "codex-error-test", version: "0" } },
    })}\n`,
  );
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "consult", arguments: arguments_ } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, Number(extraEnv.AGENT_COLLAB_TIMEOUT_MS ?? 300) + 300));
  child.kill();
  const messages = stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const response = messages.find((message) => message.id === 2);
  if (!response) {
    throw new Error(`No tool response. stdout=${stdout} stderr=${stderr}`);
  }
  return response;
}

try {
  const missingFile = await callTool({ question: "missing", files: ["missing.txt"], target: "claude" });
  if (!missingFile.error?.message.includes("File not found")) {
    throw new Error(`Expected missing-file MCP error, got ${JSON.stringify(missingFile)}`);
  }

  const outsideFile = await callTool({ question: "outside", files: [path.join(repoRoot, "SPEC.md")], target: "claude" });
  if (!outsideFile.error?.message.includes("outside project root")) {
    throw new Error(`Expected outside-root MCP error, got ${JSON.stringify(outsideFile)}`);
  }

  const oversized = await callTool(
    { question: "this question is intentionally too large", target: "claude" },
    { AGENT_COLLAB_MAX_PROMPT_BYTES: "10" },
  );
  if (!oversized.error?.message.includes("Prompt too large")) {
    throw new Error(`Expected oversized-prompt MCP error, got ${JSON.stringify(oversized)}`);
  }

  const missingCli = await callTool({ question: "missing cli", target: "claude" }, { AGENT_COLLAB_CLAUDE_CMD: "definitely-not-a-real-agent-cli" });
  const missingCliPayload = JSON.parse(missingCli.result.content[0].text);
  if (!missingCliPayload.error?.includes("CLI not found")) {
    throw new Error(`Expected missing CLI tool error, got ${JSON.stringify(missingCliPayload)}`);
  }

  const earlyExit = await callTool(
    { question: "x".repeat(1024 * 128), target: "claude" },
    { AGENT_COLLAB_CLAUDE_CMD: `node ${exitAgentPath}` },
  );
  const earlyExitPayload = JSON.parse(earlyExit.result.content[0].text);
  if (!earlyExitPayload.error?.includes("exited with code")) {
    throw new Error(`Expected early-exit tool error without MCP crash, got ${JSON.stringify(earlyExitPayload)}`);
  }

  const timeout = await callTool(
    { question: "timeout", target: "claude" },
    { AGENT_COLLAB_CLAUDE_CMD: `node ${hangingAgentPath}`, AGENT_COLLAB_TIMEOUT_MS: "100" },
  );
  const timeoutPayload = JSON.parse(timeout.result.content[0].text);
  if (!timeoutPayload.error?.includes("timed out")) {
    throw new Error(`Expected timeout tool error, got ${JSON.stringify(timeoutPayload)}`);
  }

  console.log("error tests passed");
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
}
