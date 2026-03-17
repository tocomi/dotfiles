#!/bin/bash
input=$(cat)

cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')
model=$(echo "$input" | jq -r '.model.display_name // empty')
model_id=$(echo "$input" | jq -r '.model.id // empty')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
total_input=$(echo "$input" | jq -r '.context_window.total_input_tokens // empty')
total_output=$(echo "$input" | jq -r '.context_window.total_output_tokens // empty')
transcript_path=$(echo "$input" | jq -r '.transcript_path // empty')

# ANSI color codes (ANSI-C quoting so escapes are interpreted in all contexts)
BLUE=$'\033[34m'
GREEN=$'\033[32m'
CYAN=$'\033[36m'
YELLOW=$'\033[33m'
MAGENTA=$'\033[35m'
DIM=$'\033[2m'
RESET=$'\033[0m'

# Git branch (skip optional lock)
if git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch=$(git -C "$cwd" -c gc.auto=0 symbolic-ref --short HEAD 2>/dev/null)
fi

# Directory: basename of cwd
dir=$(basename "$cwd")

# Context usage indicator
if [ -n "$used" ] && [ "$used" != "null" ]; then
  used_int=$(printf "%.0f" "$used")
  ctx_str="${DIM} | ${RESET}${YELLOW}🪣 ${used_int}%${RESET}"
else
  ctx_str=""
fi

# Branch info
if [ -n "$branch" ]; then
  branch_str="${DIM} | ${RESET}${GREEN}🌱 ${branch}${RESET}"
else
  branch_str=""
fi

# Model info
if [ -n "$model" ]; then
  model_str="${CYAN}🤖 ${model}${RESET}"
else
  model_str=""
fi

# Estimated cost from total session tokens
# Pricing per 1M tokens (approximate, based on model ID):
#   claude-opus*:   input $15, output $75
#   claude-sonnet*: input $3,  output $15
#   claude-haiku*:  input $0.8, output $4
cost_str=""
if [ -n "$total_input" ] && [ "$total_input" != "null" ] && \
   [ -n "$total_output" ] && [ "$total_output" != "null" ]; then
  case "$model_id" in
    claude-opus*)   input_rate="15"; output_rate="75" ;;
    claude-haiku*)  input_rate="0.8"; output_rate="4" ;;
    *)              input_rate="3";  output_rate="15" ;;
  esac
  cost=$(awk "BEGIN { printf \"%.4f\", ($total_input * $input_rate + $total_output * $output_rate) / 1000000 }")
  cost_str="${DIM} | ${RESET}${MAGENTA}💸 \$${cost}${RESET}"
fi

# Changed lines from transcript (sum of line diffs in edit tool calls)
lines_str=""
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  changed_lines=$(python3 - "$transcript_path" <<'PYEOF'
import sys, json

path = sys.argv[1]
added = 0
removed = 0

try:
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            # Look for assistant tool_use messages with edit-like tools
            if obj.get("type") != "assistant":
                continue
            msg = obj.get("message", {})
            for block in msg.get("content", []):
                if block.get("type") != "tool_use":
                    continue
                tool = block.get("name", "")
                inp = block.get("input", {})
                if tool in ("Edit", "str_replace_editor", "str_replace_based_editor_tool"):
                    old = inp.get("old_string", inp.get("old_str", ""))
                    new = inp.get("new_string", inp.get("new_str", ""))
                    removed += len(old.splitlines()) if old else 0
                    added   += len(new.splitlines()) if new else 0
                elif tool == "Write":
                    content = inp.get("content", "")
                    added += len(content.splitlines()) if content else 0
except Exception:
    pass

if added or removed:
    print(f"+{added}/-{removed}")
PYEOF
  )
  if [ -n "$changed_lines" ]; then
    lines_str="${DIM} | ${RESET}${GREEN}✏️ ${changed_lines}${RESET}"
  fi
fi

# Line 1: directory, git branch, and changed lines
printf "%s%s%s\n" "${BLUE}📁 ${dir}${RESET}" "$branch_str" "$lines_str"
# Line 2: model, context usage, estimated cost
printf "%s%s%s\n" "$model_str" "$ctx_str" "$cost_str"
