# agent-collab-mcp

A small local MCP server for supervised collaboration between Claude Code and Codex CLI.

It exposes four tools:

- `consult` asks the other agent for a one-shot answer, optionally including files and `git diff`.
- `post_handoff` writes a structured note for the other agent.
- `get_context` reads recent handoffs, decisions, and consult metadata.
- `record_decision` appends a durable project decision.

The implementation is dependency-free Node.js so it can run without `npm install`.

## Requirements

- Node.js 20 or newer.
- Codex CLI on PATH for Claude-to-Codex consults.
- Claude CLI on PATH for Codex-to-Claude consults, or set `AGENT_COLLAB_CLAUDE_CMD`.

Verify the CLIs:

```powershell
codex --version
codex exec - < NUL
claude --version
claude -p "ping"
echo ping | claude -p
```

On this machine, `codex exec -` has been verified with `codex-cli 0.130.0-alpha.5`. If `claude` is not on PATH from the shell that launches the MCP server, set `AGENT_COLLAB_CLAUDE_CMD` to the full command. On Windows, npm-installed CLIs often appear as `.cmd` shims; the server runs subprocesses through the Windows shell so bare commands like `claude` can resolve those shims.

## Register

From Claude Code:

```powershell
claude mcp add agent-collab-mcp -- node C:\Users\gijsv\agent-collab\src\index.mjs
```

For Codex, add an MCP stdio server entry that runs:

```powershell
node C:\Users\gijsv\agent-collab\src\index.mjs
```

Recommended project-specific environment:

```powershell
$env:AGENT_COLLAB_PROJECT_ROOT = "C:\path\to\your\project"
```

## Configuration

```text
AGENT_COLLAB_PROJECT_ROOT       project root override
AGENT_COLLAB_CALLER             claude | codex fallback when client identity is unknown
AGENT_COLLAB_DIR                default: <project_root>/.agent-collab
AGENT_COLLAB_TIMEOUT_MS         default: 300000
AGENT_COLLAB_CODEX_CMD          default: codex exec -
AGENT_COLLAB_CLAUDE_CMD         default: claude -p
AGENT_COLLAB_MAX_FILE_BYTES     default: 262144
AGENT_COLLAB_MAX_PROMPT_BYTES   default: 1048576
AGENT_COLLAB_MAX_RESPONSE_BYTES default: 262144
```

Command overrides are split on simple shell-like whitespace and quotes. They are meant for straightforward commands such as `claude -p` or `"C:\path with spaces\claude.cmd" -p`, not complex shell pipelines.

Storage is append-only JSONL at `<project_root>/.agent-collab/log.jsonl` unless `AGENT_COLLAB_DIR` overrides it. Consult logs include prompt and response text, but only file paths are logged, not file contents.

Consult subprocesses run with their working directory set to the resolved project root. Set `AGENT_COLLAB_PROJECT_ROOT` when launching from tools that use a different process cwd.

## Example Tool Calls

Ask the other agent for a review:

```json
{
  "question": "Review this change for edge cases.",
  "files": ["src/App.tsx"],
  "include_git_diff": true,
  "mode": "review"
}
```

Record a decision:

```json
{
  "text": "Use JSONL for v1 storage.",
  "rationale": "Append-only logs are easy to inspect and recover.",
  "tags": ["storage", "v1"]
}
```

## Notes

This is intentionally human-supervised. It does not create autonomous loops between agents. Use `consult` and `post_handoff` manually until the workflow becomes boring enough to automate.
