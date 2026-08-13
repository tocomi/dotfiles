#!/bin/bash
input=$(cat)

cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')
model=$(echo "$input" | jq -r '.model.display_name // empty')
model_id=$(echo "$input" | jq -r '.model.id // empty')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
total_input=$(echo "$input" | jq -r '.context_window.total_input_tokens // empty')
total_output=$(echo "$input" | jq -r '.context_window.total_output_tokens // empty')
transcript_path=$(echo "$input" | jq -r '.transcript_path // empty')
effort=$(echo "$input" | jq -r '.effort.level // empty')

# ANSI color codes (ANSI-C quoting so escapes are interpreted in all contexts)
BLUE=$'\033[34m'
GREEN=$'\033[32m'
CYAN=$'\033[36m'
YELLOW=$'\033[33m'
MAGENTA=$'\033[35m'
RED=$'\033[31m'
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

# Reasoning effort level (absent when the model has no effort parameter)
if [ -n "$effort" ] && [ "$effort" != "null" ]; then
  case "$effort" in
    low)          effort_color="$DIM" ;;
    medium)       effort_color="$GREEN" ;;
    high)         effort_color="$YELLOW" ;;
    xhigh|max)    effort_color="$RED" ;;
    *)            effort_color="$DIM" ;;
  esac
  effort_str=" ${effort_color}(${effort})${RESET}"
else
  effort_str=""
fi

# Model info
if [ -n "$model" ]; then
  model_str="${CYAN}🤖 ${model}${RESET}${effort_str}"
else
  model_str=""
fi

# Rate limit usage (5h and 7d windows) - cached 60s
USAGE_CACHE="/tmp/claude-usage-cache.json"
USAGE_TTL=60

get_usage_data() {
  if [ -f "$USAGE_CACHE" ]; then
    cache_age=$(( $(date +%s) - $(stat -f %m "$USAGE_CACHE" 2>/dev/null || echo 0) ))
    if [ "$cache_age" -lt "$USAGE_TTL" ]; then
      cat "$USAGE_CACHE"
      return
    fi
  fi

  # Get OAuth token from macOS Keychain
  token=""
  if command -v security >/dev/null 2>&1; then
    creds=$(security find-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w 2>/dev/null) || true
    [ -n "$creds" ] && token=$(echo "$creds" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
  fi
  # Fallback: credentials file
  if [ -z "$token" ]; then
    for cred_file in "$HOME/.claude/.credentials.json" "$HOME/.config/claude/credentials.json"; do
      if [ -f "$cred_file" ]; then
        token=$(jq -r '.claudeAiOauth.accessToken // empty' "$cred_file" 2>/dev/null)
        [ -n "$token" ] && break
      fi
    done
  fi

  [ -z "$token" ] && return

  result=$(curl -sf --max-time 5 \
    -H "Authorization: Bearer $token" \
    -H "anthropic-beta: oauth-2025-04-20" \
    "https://api.anthropic.com/api/oauth/usage" 2>/dev/null)

  if [ -n "$result" ]; then
    echo "$result" > "$USAGE_CACHE"
    echo "$result"
  fi
}

# Format ISO 8601 (UTC) reset time -> JST "HH:MM" (same day) or "MM/DD HH:MM" (other day)
format_reset() {
  local t="$1"
  [ -z "$t" ] && return
  # Strip microseconds and timezone offset -> bare "YYYY-MM-DDTHH:MM:SS"
  local t_clean
  t_clean=$(echo "$t" | sed 's/\.[0-9]*//' | sed 's/[+-][0-9][0-9]:[0-9][0-9]$//' | sed 's/Z$//')
  # Parse as UTC (+0000), output in JST (UTC+9)
  local jst
  jst=$(TZ="Asia/Tokyo" date -jf "%Y-%m-%dT%H:%M:%S%z" "${t_clean}+0000" "+%m/%d %H:%M" 2>/dev/null \
     || TZ="Asia/Tokyo" date -d "${t_clean}Z" "+%m/%d %H:%M" 2>/dev/null) || { echo "$t"; return; }
  # Today in JST
  local today
  today=$(TZ="Asia/Tokyo" date "+%m/%d")
  local reset_day="${jst%% *}"
  if [ "$reset_day" = "$today" ]; then
    echo "${jst##* }"   # 時刻のみ
  else
    echo "$jst"          # MM/DD HH:MM
  fi
}

rate_str=""
usage_data=$(get_usage_data 2>/dev/null)
if [ -n "$usage_data" ]; then
  five_util=$(echo "$usage_data" | jq -r '.five_hour.utilization // empty')
  five_reset=$(echo "$usage_data" | jq -r '.five_hour.resets_at // empty')
  seven_util=$(echo "$usage_data" | jq -r '.seven_day.utilization // empty')
  seven_reset=$(echo "$usage_data" | jq -r '.seven_day.resets_at // empty')

  if [ -n "$five_util" ] && [ "$five_util" != "null" ] && \
     [ -n "$seven_util" ] && [ "$seven_util" != "null" ]; then
    five_pct=$(printf "%.0f" "$five_util")
    seven_pct=$(printf "%.0f" "$seven_util")
    five_reset_fmt=$(format_reset "$five_reset")
    seven_reset_fmt=$(format_reset "$seven_reset")
    rate_str="${CYAN}🕐 ${five_pct}%(↺${five_reset_fmt})${RESET}${DIM} | ${RESET}${CYAN}🗓️ ${seven_pct}%(↺${seven_reset_fmt})${RESET}"
  fi
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
    print(f"+{added}|{removed}")
PYEOF
  )
  if [ -n "$changed_lines" ]; then
    added_part="${changed_lines%%|*}"
    removed_part="${changed_lines##*|}"
    lines_str="${DIM} | ${RESET}${GREEN}✏️ ${added_part}${RESET}/${RED}-${removed_part}${RESET}"
  fi
fi

# Line 1: directory, git branch, and changed lines
printf "%s%s%s\n" "${BLUE}📁 ${dir}${RESET}" "$branch_str" "$lines_str"
# Line 2: model, context usage, estimated cost
printf "%s%s%s\n" "$model_str" "$ctx_str" "$cost_str"
# Line 3: rate limits (5h and 7d)
if [ -n "$rate_str" ]; then
  printf "%s\n" "$rate_str"
fi
