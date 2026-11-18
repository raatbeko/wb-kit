#!/bin/bash
# Common functions for MPSTATS scripts

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -d "$SCRIPT_DIR/../config" ]]; then
  SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [[ -d "$SCRIPT_DIR/../../config" ]]; then
  SKILL_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
else
  SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

CONFIG_FILE="$SKILL_ROOT/config/.env"

load_config() {
  # wb-kit: токен берётся из общего .env в корне набора (.claude/skills/mpstats → ../../..),
  # чтобы клиент вписывал его один раз. config/.env навыка по-прежнему работает.
  local root_env="$SKILL_ROOT/../../../.env"
  if [[ -z "${MPSTATS_TOKEN:-}" && -f "$root_env" ]]; then
    local v
    v=$(grep -E '^MPSTATS_TOKEN=' "$root_env" | tail -1 | cut -d= -f2- | tr -d '\r' | sed 's/^["'\'']//;s/["'\'']$//')
    [[ -n "$v" ]] && export MPSTATS_TOKEN="$v"
  fi

  if [[ -f "$CONFIG_FILE" ]]; then
    while IFS='=' read -r key value; do
      # Skip comments and empty lines
      [[ "$key" =~ ^[[:space:]]*# ]] && continue
      [[ -z "$key" ]] && continue
      # Strip surrounding whitespace and quotes
      key=$(printf '%s' "$key" | xargs)
      value=$(printf '%s' "$value" | sed 's/^["'\''"]//;s/["'\''"]$//')
      export "$key=$value"
    done < "$CONFIG_FILE"
  fi

  if [[ -z "${MPSTATS_TOKEN:-}" ]]; then
    echo '{"error":"MPSTATS_TOKEN not set. Configure config/.env or export MPSTATS_TOKEN."}' >&2
    echo "See: mpstats/config/README.md" >&2
    exit 1
  fi
}
