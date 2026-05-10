# agent-collab-mcp -- v1 Spec

A local MCP server that lets Claude Code and Codex CLI collaborate on the user's projects via four tools: quick consults, durable handoffs, shared context retrieval, and an append-only decision log.

Default implementation language: TypeScript (Node 20+). Python (3.11+) is an acceptable substitute if Node is unavailable; the on-the-wire MCP behaviour is identical. Transport: stdio. Server name: `agent-collab-mcp`.

---

## Tools

### 1. `consult`

Synchronous one-shot to the other agent. Caller is auto-detected from MCP `clientInfo.name`: names matching `/claude/i` route to codex; names matching `/codex/i` route to claude. If the name matches neither and `AGENT_COLLAB_CALLER` is unset, the call MUST include an explicit `target` and the caller is logged as `unknown`.

**Input**

| field              | type                                                       | required | notes                                                       |
| ------------------ | ---------------------------------------------------------- | -------- | ----------------------------------------------------------- |
| `question`         | string                                                     | yes      | The actual prompt to send.                                  |
| `files`            | string[]                                                   | no       | Paths relative to project root. Absolute paths must stay in project root. |
| `include_git_diff` | bool                                                       | no       | If true, append `git diff` output to prompt.                |
| `mode`             | `'review' \| 'plan' \| 'debug' \| 'ux' \| 'architecture'` | no       | Prepends a fixed system instruction (see below).            |
| `target`           | `'codex' \| 'claude'`                                     | no       | Overrides auto-detected target. Required when caller is unknown. |

**Output**

```json
{ "consult_id": "uuid", "response": "string", "latency_ms": 1234, "truncated": false }
```

**Mode prefixes** (server prepends verbatim):

- `review` -- "You are reviewing the included material for bugs, edge cases, and detail issues. Be terse. Cite file:line. Don't restate what the code does."
- `plan` -- "You are proposing an implementation approach. Be concrete about steps, files affected, and tradeoffs. Don't write the code."
- `debug` -- "You are debugging. Form hypotheses, suggest checks, identify likely root cause. Don't fix yet."
- `ux` -- "You are reviewing user-facing behavior. Focus on user-visible issues, naming, error messages, and edge interactions."
- `architecture` -- "Sanity-check an architectural choice. Surface load-bearing assumptions and failure modes."

**Prompt assembly order:** `[mode prefix]\n\n[question]\n\n[--- path ---\ncontents ...]\n\n[--- git diff ---\n...]`.

### 2. `post_handoff`

Durable structured note left for the other agent.

**Input**

| field            | type     | required |
| ---------------- | -------- | -------- |
| `summary`        | string   | yes      |
| `changed_files`  | string[] | no       |
| `open_questions` | string[] | no       |
| `next_steps`     | string[] | no       |

`from` is auto-filled from caller identity (or `AGENT_COLLAB_CALLER`, or `unknown`).

**Output**: `{ "handoff_id": "uuid" }`

### 3. `get_context`

Read recent shared state. The other agent should call this at session start.

**Input**

| field              | type   | default |
| ------------------ | ------ | ------- |
| `limit_handoffs`   | number | 5       |
| `limit_decisions`  | number | 20      |
| `limit_consults`   | number | 10      |
| `since`            | string | unset   |

**Output**

```json
{
  "handoffs":   [ { "id", "timestamp", "from", "summary", "changed_files", "open_questions", "next_steps" } ],
  "decisions":  [ { "id", "timestamp", "author", "text", "rationale", "tags" } ],
  "consults":   [ { "id", "timestamp", "caller", "target", "mode", "question_preview" } ]
}
```

Most recent first. `question_preview` is the first 200 characters of the question.

### 4. `record_decision`

Append-only. Once recorded, decisions are not edited or deleted by the server -- only superseded by a new decision that references the prior id in `rationale`.

**Input**

| field       | type     | required |
| ----------- | -------- | -------- |
| `text`      | string   | yes      |
| `rationale` | string   | no       |
| `tags`      | string[] | no       |

`author` is auto-filled.

**Output**: `{ "decision_id": "uuid" }`

---

## Storage

All under the resolved project root + `/.agent-collab/`.

Project root resolution, in order of precedence:

1. `AGENT_COLLAB_PROJECT_ROOT` env var, if set.
2. MCP roots advertised by the client (use the first root whose URI is a `file://` path), if available.
3. The server process `cwd`.

This matters because Claude Code and Codex may launch the server with different working directories. Treat (1) as the reliable override; document it in the README.

Files:

- `log.jsonl` -- append-only, one JSON object per line. Event types: `consult`, `handoff`, `decision`. Each line carries `{ id, type, timestamp, ...type-specific }`.
- No `state.json` in v1.

`get_context` reads `log.jsonl` from the tail backward and reconstructs in memory. Fine up to ~10^5 entries; add an index later if needed.

**Logged fields per type**

- `consult` -- `id, type, timestamp, caller, target, mode?, question, prompt_prefix?, files[], include_git_diff, response, latency_ms, truncated, stderr_tail?, error?`
- `handoff` -- `id, type, timestamp, from, summary, changed_files[], open_questions[], next_steps[]`
- `decision` -- `id, type, timestamp, author, text, rationale?, tags[]`

For consults, log the full response text. File *contents* are NOT logged -- only paths.

---

## Subprocess invocation

Command per target is configurable; defaults below. The server passes the assembled prompt via stdin (avoids shell quoting issues and arg length limits).

| target   | default command   | env override               |
| -------- | ----------------- | -------------------------- |
| `codex`  | `codex exec -`    | `AGENT_COLLAB_CODEX_CMD`   |
| `claude` | `claude -p`       | `AGENT_COLLAB_CLAUDE_CMD`  |

Notes:

- Confirmed: `codex exec -` reads instructions from stdin (codex-cli 0.130.0-alpha.5 verified).
- `claude` may not be on PATH from every shell. Treat the Claude command as install-time configuration: the README must walk the user through verifying `claude -p "ping"` works from their shell, and falling back to `AGENT_COLLAB_CLAUDE_CMD` with the absolute path if not.
- stderr is captured and included in log only; not returned to caller unless exit code is non-zero, in which case it's surfaced in the error response (last 4 KiB).

---

## Limits and errors

| limit                  | default     | env override                      |
| ---------------------- | ----------- | --------------------------------- |
| Per-file size          | 256 KiB     | `AGENT_COLLAB_MAX_FILE_BYTES`     |
| Total assembled prompt | 1 MiB       | `AGENT_COLLAB_MAX_PROMPT_BYTES`   |
| Subprocess timeout     | 300 s       | `AGENT_COLLAB_TIMEOUT_MS`         |
| Response truncation    | 256 KiB     | `AGENT_COLLAB_MAX_RESPONSE_BYTES` |

**Failure modes**

- Subprocess not on PATH -> MCP error: `"<target> CLI not found on PATH; set AGENT_COLLAB_<TARGET>_CMD"`.
- Non-zero exit -> return `{ error, stderr_tail }` in tool result; log with `error` field set.
- Timeout -> kill subprocess (SIGTERM, then SIGKILL after 5s); return timeout error; log it.
- File not found / outside project root -> reject upfront, listing the offending path.
- Prompt size exceeded -> reject upfront with byte count.
- Log write failure -> consult itself still returns its result; log error printed to stderr. Best-effort logging, not transactional.

**Concurrency:** v1 is designed for a single server process per project, single writer at a time. JSONL appends from one process are typically safe (the OS buffer flush on a single `write()` of a complete line is a line-atomic write in practice on the platforms we care about), but this is best-effort, not a hard guarantee. If two MCP server instances ever target the same `log.jsonl`, lines may interleave. Document this; revisit with file locking only if it bites.

---

## Configuration

Environment variables:

```
AGENT_COLLAB_PROJECT_ROOT       project root override (optional but recommended)
AGENT_COLLAB_CALLER             "claude" | "codex"; fallback when clientInfo.name is unrecognized
AGENT_COLLAB_DIR                default: <project_root>/.agent-collab
AGENT_COLLAB_TIMEOUT_MS         default: 300000
AGENT_COLLAB_CODEX_CMD          default: "codex exec -"
AGENT_COLLAB_CLAUDE_CMD         default: "claude -p"      (verify on install -- see Subprocess section)
AGENT_COLLAB_MAX_FILE_BYTES     default: 262144
AGENT_COLLAB_MAX_PROMPT_BYTES   default: 1048576
AGENT_COLLAB_MAX_RESPONSE_BYTES default: 262144
```

Registration: user runs `claude mcp add agent-collab-mcp -- node /path/to/dist/index.js` (and the equivalent in Codex's MCP config).

---

## Out of scope for v1

Deliberate omissions, to revisit only when the manual flow shows real friction:

- `request_review` / `submit_review` (use `consult` + `post_handoff` for now)
- `claim_task`, `create_task` (no task model yet)
- Severity taxonomies on review output
- Automated builder/reviewer loops
- File-locking for concurrent writers
- Decision supersession as a first-class operation
- Per-project session ids / multiple parallel sessions in one repo
- Streaming responses (return whole response only)

---

## Acceptance checklist

A v1 build is done when:

- [ ] All four tools registered, schemas validate.
- [ ] `consult` round-trips Claude -> Codex and Codex -> Claude with files and `git diff`.
- [ ] All four tools append correct JSONL entries.
- [ ] `get_context` returns the most recent items, newest first.
- [ ] Timeout, missing-CLI, missing-file, oversized-prompt all produce clean errors (no crash).
- [ ] Caller auto-detection works; `AGENT_COLLAB_CALLER` fallback works; explicit `target` works.
- [ ] Project root resolution honors `AGENT_COLLAB_PROJECT_ROOT`, then MCP roots, then cwd.
- [ ] Mode prefixes are prepended verbatim and visible in logged `question`.
- [ ] README has a 5-line "register in Claude Code" / "register in Codex" snippet and a "verify claude/codex CLIs" check.
