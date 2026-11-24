---
name: deepseek-subagent
description: Delegate coding, refactoring, testing, or read-only server diagnostics to DeepSeek V4.1 Flash inside the official DeepSeek Harness (`ds-subagent` CLI) with durable named sessions, reactive background wakeup, live tasklists, `--mode readonly` safety enforcement, automatic secret redaction, non-git change tracking, and remote Linux server (`--host`) support. Works in both Antigravity and Claude Code.
---

# DeepSeek Harness Subagent (`ds-subagent` v2.2)

`ds-subagent` runs DeepSeek V4.1 Flash (1M context window) inside the official DeepSeek Harness `subagent` profile. Every subagent gets a durable **named session**, live progress checklist (`todo_write`), automatic secret redaction, git & non-git file-change tracking, and reactive wakeup.

## Core Rule: Always Run Turns in the Background (Reactive Wakeup)

Never poll in a loop. Always run `start` and `send` as background commands so the host wakes you up automatically the instant DeepSeek finishes, asks a question, hits a safety boundary, or gets stuck:

- **In Antigravity:** call `run_command` with `WaitMsBeforeAsync: 500` and `NotificationTimeoutSeconds: 300`, then stop calling tools (or do parallel work). The system wakes you when `ds-subagent` exits.
- **In Claude Code:** call the `Bash` tool with `run_in_background: true`. *(Note: on Windows, Claude Code's shell tool is still named `Bash`, even when running PowerShell or Git Bash commands — `ds-subagent` works identically in both.)*

## CLI Reference

```sh
# Start a new named session (use --prompt-file for large specs!)
ds-subagent start <name> --cwd <project-dir> [--mode readonly|workspace|full] "<task>"
ds-subagent start <name> --cwd <project-dir> --prompt-file <brief.md>

# Strict read-only mode (for production / diagnostics — technically enforced!)
ds-subagent start audit --cwd /var/www/app --readonly --allow-cmd "git status" --allow-cmd "sqlite3 -readonly" "Inspect config and DB counts"

# Install & run on a remote Linux server (systemd + linger; survives PC sleep/shutdown!)
ds-subagent host install prod --ssh user@server --api-key-stdin < mistral.key
ds-subagent doctor --host prod
ds-subagent start prod-audit --host prod --cwd /srv/app --readonly "Check logs and config"

# Continue, steer mid-flight, watch live checklist, inspect, cancel, or close
ds-subagent send   <name> "<reply or next task>"
ds-subagent steer  <name> "<mid-flight course correction>"
ds-subagent status [name]
ds-subagent watch  [name]
ds-subagent log    <name> --tail 20
ds-subagent cancel <name>
ds-subagent close  <name>

# Safe remote script execution (avoids PowerShell -> SSH quote bugs)
ds-subagent ssh-exec user@server --file script.sh

# Health, auto-repair, autostart, diagnostics, and updates
ds-subagent doctor --fix
ds-subagent daemon autostart on|off
ds-subagent report
ds-subagent update
```

### Important Flag & Safety Notes
- **Safety modes (`--mode` / `--readonly`):**
  - `--readonly` (or `--mode readonly`): enforced **BEFORE tool execution** via DSH's synchronous `tools.guard()` + native `read-only` sandbox. A single blocked write or disallowed command returns a denial error to DeepSeek so it can continue innocent read work (`BLOCKED_ATTEMPTS` is shown); pure-blocked turns or repeated bypass loops return exit code `13`. Shell-escape binaries (`ssh`, `scp`, `rsync`, `bash`, `node`, `python`, `curl`, bare `sqlite3`, etc.) are **forbidden** in `--allow-cmd`; safe `sqlite3 -readonly` queries (`--allow-cmd "sqlite3 -readonly"`) ARE allowed (with `.shell`/`.output` and mutating SQL blocked). For remote read-only work, always use `--host <alias> --readonly`.
  - `--mode workspace`: sets DSH sandbox to `workspace-write` and blocks write/edit paths outside `--cwd`.
  - `--mode full` (default): full autonomous coding access.
- **Secret redaction is ON by default:** API keys, Bearer tokens, JWTs, PEM private keys, DB credentials, Amazon LWA tokens/secrets/client IDs (`Atzr|...`, `amzn1.oa2-cs.v1...`, `amzn1.application-oa2-client...`), and `.env` `KEY=`/`SECRET=`/`TOKEN=` lines are automatically redacted from replies, errors, and logs.
- **Omit `--effort` on Mistral `deepseek-v4-1-flash-1017`** — Mistral rejects explicit `--effort` overrides on that model.
- **Use `--prompt-file <path>`** for large specs on Windows to avoid shell quoting limits.
- **Non-git projects & live servers supported:** if `--cwd` is not a git repo, `ds-subagent` tracks DeepSeek's edits and ignores live runtime/DB/log churn (`*.db*`, `*.sqlite*`, `*.log*`, `*.pid`, `*.lock`, `logs/`, `tmp/`), and skips `CHANGED_FILES` in `--readonly` mode. `host install` auto-installs user-local Node 24.9+ (SHA256-verified), `pnpm`, pinned `@deepseek-ai/dsh@0.2.2-rc.5`, and a dedicated `PATH` in systemd.

## Exit Codes & Exactly How to React

| Exit | Status | Meaning | Next Action |
|---|---|---|---|
| `0` | `DONE` | Turn completed cleanly | Check `CHANGED_FILES`, `TASKS`, and token stats; continue with `send` or `close`. |
| `10` | `NEEDS_INPUT` | DeepSeek asked a question (`ask_user_question` or `[NEEDS_INPUT]`) | Read the question; answer with `ds-subagent send <name> "<decision>"` (or ask the user first). |
| `11` | `STUCK` | Idle watchdog, max-turn timeout, or repeated tool error loop tripped | Read `ERROR` and `LAST_EVENTS`; unblock with `send` or take over directly. |
| `12` | `CANCELLED` | Explicitly cancelled | Resume with `send` or `close`. |
| `13` | `BLOCKED_POLICY` | Attempted a write or disallowed shell command in `readonly`/`workspace` mode | Review `ERROR`; keep readonly or re-run with explicit `--allow-cmd` / `--mode`. |
| `4` | `ERROR` | Model/API/runtime error | Inspect error; run `ds-subagent report` if persistent. |
| `2` | `BRIDGE_DOWN` | Daemon offline | Run `ds-subagent doctor --fix` (local) or check SSH/systemd on remote `--host`. |
