import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const testRoot = path.join(repoRoot, ".smoke-tmp");
const serverPath = path.join(repoRoot, "src", "index.mjs");
const echoAgentPath = path.join(testRoot, "echo-agent.mjs");

await fs.rm(testRoot, { recursive: true, force: true });
await fs.mkdir(testRoot, { recursive: true });
await fs.writeFile(path.join(testRoot, "sample.txt"), "hello from sample\n", "utf8");
await fs.writeFile(
  echoAgentPath,
  "let d=''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => { process.stderr.write('note from echo agent'); process.stdout.write('CWD:' + process.cwd() + '\\nECHO:' + d); });\n",
  "utf8",
);

const child = spawn("node", [serverPath], {
  env: {
    ...process.env,
    AGENT_COLLAB_PROJECT_ROOT: testRoot,
    AGENT_COLLAB_CALLER: "claude",
    AGENT_COLLAB_CLAUDE_CMD: `node ${echoAgentPath}`,
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

function send(id, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

send(1, "initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "codex-smoke", version: "0" } });
send(2, "tools/list", {});
send(3, "tools/call", { name: "record_decision", arguments: { text: "Use JSONL for v1.", tags: ["test"] } });
send(4, "tools/call", { name: "post_handoff", arguments: { summary: "Testing handoff", changed_files: ["src/index.mjs"] } });
send(5, "tools/call", { name: "consult", arguments: { question: "Check this", files: ["sample.txt"], mode: "review" } });
send(6, "tools/call", { name: "get_context", arguments: {} });

try {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  child.kill();

  if (stderr.trim()) {
    throw new Error(`Unexpected stderr:\n${stderr}`);
  }

  const messages = stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  for (const id of [1, 2, 3, 4, 5, 6]) {
    const message = messages.find((entry) => entry.id === id);
    if (!message) {
      throw new Error(`Missing response id ${id}`);
    }
    if (message.error) {
      throw new Error(`Response ${id} errored: ${JSON.stringify(message.error)}`);
    }
  }

  const consult = JSON.parse(messages.find((entry) => entry.id === 5).result.content[0].text);
  if (!consult.response.includes("ECHO:") || !consult.response.includes("hello from sample")) {
    throw new Error("Consult response did not include echoed prompt and file content");
  }
  if (!consult.response.includes(`CWD:${testRoot}`)) {
    throw new Error(`Consult subprocess should run from project root ${testRoot}: ${consult.response}`);
  }

  const context = JSON.parse(messages.find((entry) => entry.id === 6).result.content[0].text);
  if (context.handoffs.length !== 1 || context.decisions.length !== 1 || context.consults.length !== 1) {
    throw new Error(`Unexpected context counts: ${JSON.stringify(context)}`);
  }

  const log = await fs.readFile(path.join(testRoot, ".agent-collab", "log.jsonl"), "utf8");
  const events = log.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  if (events.length !== 3 || events.some((event) => !["decision", "handoff", "consult"].includes(event.type))) {
    throw new Error(`Unexpected log events: ${log}`);
  }
  const consultEvent = events.find((event) => event.type === "consult");
  if (consultEvent.question !== "Check this" || !consultEvent.prompt_prefix?.startsWith("You are reviewing")) {
    throw new Error(`Consult log should store raw question and separate prompt prefix: ${JSON.stringify(consultEvent)}`);
  }
  if (!consultEvent.stderr_tail?.includes("note from echo agent")) {
    throw new Error(`Consult log should include stderr tail: ${JSON.stringify(consultEvent)}`);
  }
  if (consultEvent.caller !== "codex" || consultEvent.target !== "claude") {
    throw new Error(`clientInfo.name should take precedence over AGENT_COLLAB_CALLER: ${JSON.stringify(consultEvent)}`);
  }
  if (context.consults[0].question_preview !== "Check this") {
    throw new Error(`Context preview should use raw question: ${JSON.stringify(context.consults[0])}`);
  }

  console.log("smoke test passed");
} finally {
  child.kill();
  await fs.rm(testRoot, { recursive: true, force: true });
}
