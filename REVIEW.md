# agent-collab-mcp v0.1.0 -- review by Claude

Read: `src/index.mjs`, `README.md`, `package.json`, `scripts/smoke-test.mjs`, `scripts/error-test.mjs`. Did not run (no Node on PATH from this shell).

Overall: the spec acceptance checklist is satisfied and the structure is clean. The dependency-free Node choice and the sequential message-queue fix are both good calls. Findings below are ordered by what's likely to bite in real use, not by line count.

---

## P1 -- will break in real use

### 1. Windows `.cmd` / `.ps1` shim spawn

`src/index.mjs:331` `spawn(file, args, { ... })` is called without `shell: true`. On Windows, npm-installed CLIs (which Claude Code's `claude` is) ship as `claude.cmd` shims. `child_process.spawn` without a shell does not consult `PATHEXT`, so `spawn("claude", ["-p"])` fails with ENOENT even when `claude.cmd` is on PATH. `codex.exe` is a Rust binary so it's fine; `claude` is the one this hurts.

Two acceptable fixes:

- Detect `process.platform === "win32"` and pass `shell: true`. Need to be careful about quoting since `AGENT_COLLAB_*_CMD` becomes a shell string.
- Document that on Windows the user must put the full `.cmd`/`.exe` path in `AGENT_COLLAB_CLAUDE_CMD`. Less ergonomic but no shell-injection surface.

The README's "set `AGENT_COLLAB_CLAUDE_CMD`" guidance hints at this but doesn't explain *why* `claude` won't work bare on Windows. Worth calling out explicitly.

### 2. `child.stdin` has no `error` listener

`src/index.mjs:373` `child.stdin.end(prompt)` -- if the subprocess crashes before draining stdin, the write produces an EPIPE error event on `child.stdin`. With no listener, Node's default behaviour is to emit `uncaughtException` and crash the MCP server. This is the worst kind of bug because it only triggers when the subprocess is misbehaving -- exactly the path that should be most robust.

Fix:

```js
child.stdin.on("error", () => {});
child.stdin.end(prompt);
```

---

## P2 -- spec mismatches / correctness

### 3. `question_preview` is dominated by the mode prefix

`src/index.mjs:177` logs `question` as `buildLoggedQuestion(mode, args.question)` -- mode prefix prepended. `getContext` then takes `String(event.question).slice(0, 200)` for `question_preview` (`:256`).

The `review` mode prefix alone is 130+ chars, so `get_context` previews of every review consult start with the same 130 chars of static text. The actual user question is mostly hidden.

Fix: store `mode` and the raw question separately in the log event, and either build the preview from the raw question or skip the prefix on render.

### 4. stderr not included in the logged consult event

Spec, Subprocess section: "stderr is captured and included in log only; not returned to caller unless exit code is non-zero." Current code does the opposite -- `consult()` returns `stderr_tail` to the caller (`:159`) but the `finally`-block log payload (`:170-184`) has no `stderr` / `stderr_tail` field at all. Successful-but-noisy stderr is also dropped.

Fix: capture `subprocess.stderr` (or its tail) into the logged event, regardless of exit code.

### 5. `AGENT_COLLAB_CALLER` precedence inverted

`src/index.mjs:447-449` checks the env var *before* `clientInfo.name`. Spec describes it as a fallback when the client name is unrecognized. As-is, a forgotten env var permanently misattributes every consult and handoff -- silent, hard to spot in the JSONL.

Fix: try `clientInfo.name` first, fall back to the env var only when the name doesn't match `/claude|codex/i`.

---

## P3 -- minor

### 6. `splitCommand` doesn't handle escaped quotes

`:485-493` -- fine for the configured defaults, but `AGENT_COLLAB_CLAUDE_CMD="C:\Path\with \"quotes\"\claude.cmd"` would parse oddly. Document the limitation in the README rather than build a real shell parser.

### 7. Smoke test relies on a 1.2 s sleep

`scripts/smoke-test.mjs:50` -- fragile on cold caches and slow disks. Read responses event-driven (resolve a deferred per JSON-RPC id, await all six). Same fix would also let you stop spawning a Node subprocess just to echo stdin (`echo-agent.mjs`).

### 8. `latency_ms` computed twice with drift

`src/index.mjs:165` returns one value; `:181` logs another a few ms later. Compute once before the `return`/`finally`, reuse.

### 9. Smoke-test cleanup races on Windows

`scripts/smoke-test.mjs:91-92` -- `child.kill()` then immediate `fs.rm(testRoot, ...)`. On Windows, the killed child's open file handles can keep `.agent-collab/log.jsonl` locked briefly, causing EBUSY. Wait for child `exit` event before rm.

### 10. README -- one missing thing

The "Verify the CLIs" snippet (`README.md:22-27`) shows `codex exec - < NUL` but doesn't show the equivalent for `claude` (which may not even support stdin in `-p` mode -- verifying that is the actual unknown). Worth adding `echo ping | claude -p` (or whatever the right invocation is) so the user discovers the stdin question at install time, not at first consult.

---

## Not-bugs / nice things

- Sequential `messageQueue` is correct and important. Without it, `get_context` would race ahead of the `consult` log append on a busy session.
- Resolving `clientRoots` from `initialize` and using it as project-root fallback was the right call.
- `additionalProperties: false` on tool schemas catches typos early.
- Append-only is honored end-to-end -- no edit/delete code paths exist.

---

## Suggested next steps

1. Fix P1 and P2 (above). Five small edits.
2. `git init` the project and commit. No repo currently.
3. Once P1 #1 is resolved, run a real Claude->Codex consult end-to-end and post the JSONL line into a follow-up review.
4. Pencil in `request_review` / `submit_review` for v1.1 if `consult` + `post_handoff` start feeling like they want more structure.
