#!/usr/bin/env bash
# Engram session-end hook — runs once when a Claude Code session ends.
#
# Grades every memory-search result the session produced that the stop hook
# has not already graded, with no maturity wait, since nothing else is coming.
# Records helpful / irrelevant recall outcomes so promotion and decay get the
# signal they were designed around. Foreground: the session is over, there is
# nothing to keep responsive.

# A Claude CLI run that nomad-memory itself started for a completion: do nothing.
[ "${NOMAD_MEMORY_CHILD:-}" = "1" ] && exit 0

DATA_DIR="${NOMAD_MEMORY_DATA_DIR:-${NOMAD_MEMORY_DATA_DIR:-${ENGRAM_DATA_DIR:-${SMART_MEMORY_DATA_DIR:-}}}}"
if [ -z "$DATA_DIR" ]; then  # default; keep a pre-rename przm-memory store if it is the only one
  DATA_DIR="$HOME/.claude/nomad-memory"
  [ -d "$DATA_DIR" ] || [ ! -d "$HOME/.claude/przm-memory" ] || DATA_DIR="$HOME/.claude/przm-memory"
fi
PAYLOAD=$(cat 2>/dev/null || true)

CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dist/cli.js"
[ -f "$CLI" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

read -r TRANSCRIPT SESSION < <(printf '%s' "$PAYLOAD" | node -e '
  let p = {}; try { p = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch {}
  process.stdout.write((p.transcript_path || "") + " " + (p.session_id || ""));
' 2>/dev/null)

if [ -n "$TRANSCRIPT" ] && [ -n "$SESSION" ]; then
  NOMAD_MEMORY_DATA_DIR="$DATA_DIR" node "$CLI" grade --transcript "$TRANSCRIPT" --session "$SESSION" --final >/dev/null 2>&1 || true
fi
exit 0
