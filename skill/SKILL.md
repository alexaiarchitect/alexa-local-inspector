---
name: alexa-local-inspector
description: Drive the local Alexa+ MCP inspector (proxy on :6277, UI on :6274) from a coding agent — handshake, discover tools, run the voice script, link the account, read the verdict and the recorded flow. Use when asked to "inspect", "test the add-on locally", "run the voice script", "check the verdict" for an Alexa+ MCP server.
---

# Alexa+ local inspector — agent instructions

The inspector is a localhost proxy in front of the MCP server plus a browser UI. You drive it over HTTP; the UI shows what you do live and every step is recorded under the output directory (default `/tmp/alexa-local-inspector-live/`, archived per run in `sessions/<timestamp>/`).

## Step 1 — start
```
alexa-local-inspector https://your-addon.example.com/mcp --token-file .logs/user-token.txt        # or http://127.0.0.1:8787/mcp
```
`GET http://127.0.0.1:6277/health` → `{"status":"ok"}`. The UI opens at http://localhost:6274/.

## Step 2 — handshake (the legacy 2025-11-25 sequence Alexa+ uses)
`POST /handshake` (no body) — or do it yourself through `POST /mcp` with `Accept: application/json` (the proxy unwraps SSE): `initialize`, `notifications/initialized`, `tools/list`. The proxy injects `Authorization`, `MCP-Protocol-Version` and `Accept-Language`.

## Step 3 — discover tools
`GET /state` → `.tools` (also `tools.json`). Call `tools/list` a second time: `.toolsStable` must be true — Alexa+ caches the listing until the add-on is redeployed.

## Step 4 — link the account (when the server needs a user token)
`POST /link` → `{ authorizeUrl }` (the browser opens it; the user signs in). Watch `/state` `.link.status` become `linked`; `.link.scopesRequested` vs `.scopesGranted` is the evidence for scope naming.

## Step 5 — run the conversation
`POST /drive` with `{ "script": "examples/en-US.json", "brain": "none" }` (or `{ "utterance": "...", "tool": "find_categories", "args": {} }` for one turn, or `"brain": "claude"` with `ANTHROPIC_API_KEY` set). Each turn is checked: ≤ 5 options, no ids spoken, ≤ 30 s of speech, ≤ 500 ms, bare 401 without a token. Read `.conversation.summary`.

## Step 6 — visual (only for tools with `_meta.ui.resourceUri`)
`POST /visual` → screenshots per tool × surface in `screenshots/`. Voice-only tools have no widget; skip.

## Step 7 — verdict and finish
`POST /verdict` → `certification-verdict.json` (`CERTIFIED` / `CONDITIONAL` / `NOT_CERTIFIED`, rule by rule). `POST /finish` writes `inspection-summary.json` and `transcript.md` and archives the run. Report: the verdict, failed rules with evidence, p50/p95/max, and the session directory.

## Endpoints
| Endpoint | Purpose |
| --- | --- |
| `POST /mcp` | forward JSON-RPC (Accept: application/json → unwrapped JSON) |
| `GET /mcp`, `DELETE /mcp` | stream / terminate session (stateless servers answer 405) |
| `GET /events` | SSE: `state` snapshot, then `call`, `tools`, `session`, `turn`, `link`, `verdict`, `screenshot`, `error`, `finished` |
| `GET /state`, `GET /health`, `GET /recording` | snapshot, readiness, events.jsonl |
| `POST /handshake`, `/drive`, `/link`, `/visual`, `/verdict`, `/finish` | the steps above |

Never print tokens; the recorder redacts them and the UI never shows them.
