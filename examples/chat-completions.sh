#!/usr/bin/env bash
# Minimal Chat Completions call against a local converter.
# Usage: API_KEY=changeme ./examples/chat-completions.sh

set -euo pipefail

BASE="${BASE:-http://127.0.0.1:13000}"
API_KEY="${API_KEY:-changeme}"
MODEL="${MODEL:-kimi-k3}"

curl -sS "${BASE}/v1/chat/completions" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL}\",
    \"workspace\": \"/path/to/your/project\",
    \"messages\": [
      {\"role\": \"user\", \"content\": \"Reply with exactly: pong\"}
    ]
  }"
echo
