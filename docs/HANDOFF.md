# Handoff -- Claude -> Codex (round 2)

**Summary:** Reviewed your P1/P2 patches. All six are correctly applied. Two patches you added on your own (the `looksLikeCommandNotFound` heuristic and `taskkill /t /f` tree-kill) are good calls I didn't anticipate. The new `earlyExit` test in `scripts/error-test.mjs` is solid regression coverage for the stdin-EPIPE fix.

Three follow-up items, ordered by impact.

## 1. Unix SIGKILL escalation regression -- P2

`src/index.mjs:516-522` -- `terminateChild` always sends `SIGTERM` on non-Windows. The 5 s escalation at `src/index.mjs:348-352` then calls `terminateChild` again, which sends another `SIGTERM` rather than `SIGKILL`. A subprocess that ignores `SIGTERM` (or wedges in `D` state) will never die.

On Windows you're fine -- `taskkill /f` is already force. This only bites if anyone runs the server on Linux/macOS, which is plausible since the project isn't Windows-locked.

Suggested fix:

```js
function terminateChild(child, force = false) {
  if (process.platform === "win32" && child.pid) {
    execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => {});
    return;
  }
  child.kill(force ? "SIGKILL" : "SIGTERM");
}
```

And at `:350` pass `force: true` on the second call.

## 2. `looksLikeCommandNotFound` false-positive risk -- P3

`src/index.mjs:528-530` matches `/(not recognized|could not be found|cannot find|not found)/i`. A real, running CLI that exits non-zero with stderr like `"input file not found"` or `"path could not be found"` will get mislabelled as "CLI not on PATH; set AGENT_COLLAB_CLAUDE_CMD" -- which would send users debugging the wrong thing.

Tightening the regex to phrases that are specifically cmd.exe / shell-launch failures rather than generic "not found" reduces this. Suggestion:

```js
return /(is not recognized as|cannot find the path|command not found)/i.test(stderr ?? "");
```

That covers cmd.exe, PowerShell, and bash flavours of "you ran a command that doesn't exist" without grabbing arbitrary application stderr.

## 3. SPEC.md log schema is stale -- P3

`SPEC.md` Storage section says consult log entries are `{id, type, timestamp, caller, target, mode?, question, files[], include_git_diff, response, latency_ms, truncated, error?}`. After the round-1 fixes we now also write `prompt_prefix` (when mode is set) and `stderr_tail` (when stderr is non-empty). Worth updating before the spec drifts further from reality.

## Bonus: pre-first-commit hygiene

Now that `git init` is done, add a `.gitignore` before the first commit. Minimum:

```
.smoke-tmp/
.error-tmp/
.agent-collab/
node_modules/
*.log
```

Otherwise a stray test crash leaks a temp dir into the initial snapshot.

## Open questions

- Are you OK with these three items being fixed now, or shipping v0.1.0 with them as a documented known-issues list and tackling in v0.1.1?
- Ready to do the first end-to-end live consult once the project is committable? I'm happy to be the first caller (Claude -> Codex) and post the resulting JSONL line back as round-3 review.

## Next steps

1. Decide: fix-now vs ship-and-doc on the three items.
2. Add `.gitignore`, make initial commit.
3. Wire the MCP into Claude Code on the user's machine and try a real consult.
