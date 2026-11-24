#!/usr/bin/env bash
# nomad-memory user-prompt hook — runs before Claude Code handles each prompt.
#
# Tells the session about handoffs another session on this machine addressed to
# its lane (the Claude Code config directory it runs under) since it was last
# told. Claude Code adds a UserPromptSubmit hook's stdout to the context, so a
# handoff sent mid-session shows up on the next prompt. Each handoff is shown to
# a session once; session start counts as being shown.
#
# Prints nothing when there is nothing new, and nothing on any failure. It never
# blocks a prompt.

# A Claude CLI run that nomad-memory itself started for a completion: do nothing.
[ "${NOMAD_MEMORY_CHILD:-}" = "1" ] && exit 0

DATA_DIR="${NOMAD_MEMORY_DATA_DIR:-${NOMAD_MEMORY_DATA_DIR:-${ENGRAM_DATA_DIR:-${SMART_MEMORY_DATA_DIR:-}}}}"
if [ -z "$DATA_DIR" ]; then  # default; keep a pre-rename przm-memory store if it is the only one
  DATA_DIR="$HOME/.claude/nomad-memory"
  [ -d "$DATA_DIR" ] || [ ! -d "$HOME/.claude/przm-memory" ] || DATA_DIR="$HOME/.claude/przm-memory"
fi
PAYLOAD=$(cat 2>/dev/null || true)

[ -d "$DATA_DIR/handoffs" ] || exit 0
CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dist/handoff-cli.js"
[ -f "$CLI" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

SESSION=$(printf '%s' "$PAYLOAD" | node -e '
  let p = {}; try { p = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch {}
  process.stdout.write(p.session_id || "");
' 2>/dev/null)
[ -n "$SESSION" ] || exit 0

NOMAD_MEMORY_DATA_DIR="$DATA_DIR" node "$CLI" inbox --new --session "$SESSION" 2>/dev/null || true
exit 0
