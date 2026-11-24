---
name: deepseek-subagent
description: Delegate coding, refactoring, testing, or research tasks to DeepSeek V4.1 Flash running inside the official DeepSeek Harness (`ds-subagent` CLI) with durable named sessions, reactive background wakeup on completion/questions/stalls, mid-flight steering, and git diff verification. Use from both Antigravity and Claude Code.
---

# DeepSeek Harness Subagent (`ds-subagent`)

`ds-subagent` orchestrates DeepSeek V4.1 Flash (1M context window) inside the dedicated DeepSeek Harness `subagent` profile. Every subagent has a durable **named session** backed by a real DeepSeek Harness coding session (full filesystem, search, PowerShell/test execution, and compaction).

## Core Rule: Always Run Turns in the Background (Reactive Wakeup)

Never poll in a loop. Always run `start` and `send` as background commands so the host wakes you up automatically the instant DeepSeek finishes, asks a question, or gets stuck:

- **In Antigravity:** call `run_command` with `WaitMsBeforeAsync: 500` and `NotificationTimeoutSeconds: 300`, then stop calling tools (or do parallel work). The system wakes you when `ds-subagent` exits.
- **In Claude Code:** call `Bash` with `run_in_background: true`. Claude Code wakes you via `<task-notification>` when `ds-subagent` exits.

`ds-subagent` automatically starts the background DSH `subagent` daemon if it is not running yet, and uses 25-second long-poll slices internally so 20–30 minute coding turns never hit HTTP header timeouts.

## CLI Reference

```sh
# Start a new named coding session (use --prompt-file for large specs!)
ds-subagent start <name> --cwd <project-dir> [--file <path>...] "<task>"
ds-subagent start <name> --cwd <project-dir> --prompt-file <brief.md>

# Continue the same session (answer NEEDS_INPUT, review feedback, or next milestone)
ds-subagent send  <name> "<reply or next task>"

# Steer a currently running turn mid-flight without cancelling it
ds-subagent steer <name> "<course correction>"

# Inspect all sessions or live progress of one running session (non-blocking)
ds-subagent status
ds-subagent status <name>

# Read transcript, cancel a runaway turn (keeps session), or close when done
ds-subagent log    <name> --tail 20
ds-subagent cancel <name>
ds-subagent close  <name>

# Health, diagnostics, updates & daemon management
ds-subagent doctor
ds-subagent report
ds-subagent update
ds-subagent daemon start|stop|status
```

### Important Flag Notes
- **Omit `--effort` on Mistral `deepseek-v4-1-flash-1017`** — the profile default already uses DeepSeek's native reasoning, and Mistral rejects explicit `--effort` values on that model.
- **Use `--prompt-file <path>`** for large multi-paragraph specifications (especially on Windows PowerShell) to avoid shell quoting limits.
- **Watchdog tuning** (for massive 10k+ LOC refactors): `--idle 240` (max silence without session events, default `180`s), `--tool-idle 480` (while a test/build tool is running, default `360`s), `--timeout 2400` (hard max turn cap, default `1800`s), `--max-tool-errors 6` (consecutive failing tool calls before `STUCK`).
- Add `--json` when you want strict machine-readable output.

## Exit Codes & Exactly How to React

| Exit | Status | Meaning | Next Action |
|---|---|---|---|
| `0` | `DONE` | Turn completed cleanly | Check `CHANGED_FILES` & verify key tests/diffs; continue with `ds-subagent send <name> "..."` or close with `ds-subagent close <name>`. |
| `10` | `NEEDS_INPUT` | DeepSeek asked a question (`ask_user_question` or `[NEEDS_INPUT]`) and paused cleanly | Read the question. Answer directly with `ds-subagent send <name> "<decision>"`, or ask the user first if it is a product/scope decision. |
| `11` | `STUCK` | Idle watchdog, max-turn timeout, or repeated tool error loop tripped | Read `ERROR` and `LAST_EVENTS`. Either unblock with `ds-subagent send <name> "<concrete fix/approach>"` or take over directly. |
| `12` | `CANCELLED` | Explicitly cancelled via `cancel` | Resume with `ds-subagent send <name> "..."` or close. |
| `4` | `ERROR` | Model/API/runtime error | Inspect error message; fix flag/provider issue or retry once if transient. |
| `2` | `BRIDGE_DOWN` | Daemon failed to boot or unreachable | Run `ds-subagent doctor` and inspect `~/.dsh-subagent/daemon.log`. |

## Playbook for 10,000+ LOC Projects

1. **One named session per cohesive module or workstream** (e.g. `db-schema`, `auth-api`, `billing-ui`). Multiple named sessions can run in parallel as long as they edit disjoint files.
2. **Write crisp briefs with explicit acceptance criteria** (target files, interfaces/contracts, exact test/build command to run before reporting done). Put long specs in a temp markdown file and pass `--prompt-file`.
3. **Never blindly trust self-reports** — check the `CHANGED_FILES` header returned by `ds-subagent` and run your own integration/test verification at milestones.
4. **Keep sessions clean** — call `ds-subagent close <name>` once a workstream is merged/verified so `ds-subagent status` stays uncluttered.
5. **Visual inspection (optional):** while the daemon is running, all subagent sessions are also visible in the DeepSeek Harness Web UI at `http://127.0.0.1:45721`.
