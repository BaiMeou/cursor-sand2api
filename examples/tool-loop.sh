#!/usr/bin/env bash
# Two-step OpenAI tool loop (TOOL_MODE=client).
# 1) Ask the model to call get_weather.
# 2) You execute the function locally, then POST the full history back.
# Usage: API_KEY=changeme ./examples/tool-loop.sh

set -euo pipefail

BASE="${BASE:-http://127.0.0.1:13000}"
API_KEY="${API_KEY:-changeme}"
MODEL="${MODEL:-kimi-k3}"

echo "== step 1: model may return finish_reason=tool_calls =="
curl -sS "${BASE}/v1/chat/completions" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL}\",
    \"tools\": [{
      \"type\": \"function\",
      \"function\": {
        \"name\": \"get_weather\",
        \"description\": \"Return a one-line weather summary\",
        \"parameters\": {
          \"type\": \"object\",
          \"properties\": { \"city\": { \"type\": \"string\" } },
          \"required\": [\"city\"]
        }
      }
    }],
    \"messages\": [
      {\"role\": \"user\", \"content\": \"What is the weather in Taipei? Use get_weather.\"}
    ]
  }"
echo

# Step 2 — same conversation, standard OpenAI replay. Replace call_xxx and
# arguments with the values from step 1. InferenceService cannot submit tool
# results on the original HTTP/2 stream; this second POST is the whole loop.
#
# curl -sS "${BASE}/v1/chat/completions" \
#   -H "Authorization: Bearer ${API_KEY}" \
#   -H "Content-Type: application/json" \
#   -d '{
#     "model": "kimi-k3",
#     "tools": [{ "type": "function", "function": { "name": "get_weather", "parameters": { "type": "object", "properties": { "city": { "type": "string" } } } } }],
#     "messages": [
#       { "role": "user", "content": "What is the weather in Taipei? Use get_weather." },
#       {
#         "role": "assistant",
#         "tool_calls": [{
#           "id": "call_xxx",
#           "type": "function",
#           "function": { "name": "get_weather", "arguments": "{\"city\":\"Taipei\"}" }
#         }]
#       },
#       { "role": "tool", "tool_call_id": "call_xxx", "content": "{\"temp_c\":30,\"ok\":true}" }
#     ]
#   }'
