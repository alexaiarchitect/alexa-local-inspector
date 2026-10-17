# Alexa+ local inspector

A local inspector for Alexa+ MCP add-ons, built because Amazon's
`@alexa-ai/addon-local-inspector` lives in a partner-gated registry. It has the
same shape — a localhost proxy on **:6277** in front of your MCP server and a
read-mostly browser UI on **:6274**, drivable by a coding agent through plain
HTTP — and adds what Amazon's leaves out: a **simulated Alexa+ voice driver**,
**account linking** the way Alexa+ does it, and a **recording of the whole flow**.

Node 24, no runtime dependencies. Playwright is optional (visual mode only).

```bash
# terminal 1 — a server (offline stub of the vault, from the vault repo)
node scripts/local/serve.mjs --stub --seed en-US

# terminal 2 — the inspector
node bin/alexa-local-inspector.mjs http://127.0.0.1:8787/mcp --token-file ../amazonappdev2026/aobrain-vault-alexa/.logs/local-token.txt
#   proxy    http://127.0.0.1:6277/mcp  →  http://127.0.0.1:8787/mcp
#   ui       http://localhost:6274/

# one-shot, no UI: play the scripted conversation, write the verdict, exit 0/1
node bin/alexa-local-inspector.mjs drive http://127.0.0.1:8787/mcp --script examples/en-US.json --token-file ….logs/local-token.txt --no-open

# the deployed endpoint, as a real user (Google sign-in in the browser)
ALEXA_CLIENT_ID=… ALEXA_CLIENT_SECRET=… node bin/alexa-local-inspector.mjs link https://alexa.aobrain.ai/mcp --token-file .logs/user-token.txt
node bin/alexa-local-inspector.mjs drive https://alexa.aobrain.ai/mcp --script examples/en-US.json --token-file .logs/user-token.txt
```

## What it does like Alexa+

- Streamable HTTP POSTs with `MCP-Protocol-Version: 2025-11-25` (configurable:
  `--protocol-version 2025-06-18` replicates Amazon's inspector), `Accept:
application/json, text/event-stream`, a Bearer token, `Accept-Language` from
  `--locale` (and `params._meta.locale` with `--meta-locale`).
- The legacy `initialize` → `notifications/initialized` → `tools/list` handshake,
  then a second `tools/list` to prove the listing is stable (Alexa+ caches it).
- Account linking from the server's **Protected Resource Metadata** → **RFC 8414**
  metadata → authorization code + **PKCE S256** with a loopback redirect
  (`http://localhost:8976/callback`), `resource` on both requests, the scopes
  the PRM advertises. Requested vs granted scopes are recorded.
- Each turn of a script names the tool Alexa+ would pick; the answer is checked
  against the voice rules: ≤ 5 options with a page token, no identifiers spoken,
  ≤ 30 s of speech (150 wpm), ≤ 500 ms round trip, and a **bare 401** (no
  `WWW-Authenticate`) when the account is not linked.
- `--brain claude` lets Claude pick tools and arguments from the utterance
  (Anthropic Messages API, `ANTHROPIC_API_KEY`), recorded next to what the
  script expected.

## Endpoints (proxy, localhost only)

| Endpoint                                                      | Purpose                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `POST /mcp`                                                   | forward JSON-RPC; with `Accept: application/json` the SSE is unwrapped  |
| `GET /mcp`, `DELETE /mcp`                                     | server stream / terminate (stateless servers answer 405)                |
| `GET /events`                                                 | SSE for the UI and agents: `state` first, then every event              |
| `GET /state`, `GET /health`, `GET /recording`                 | snapshot, `ok`/`not-ready`, `events.jsonl`                              |
| `POST /handshake`, `/drive`, `/link`, `/visual`, `/verdict`, `/finish` | the steps of an inspection (see `skill/SKILL.md`)              |

## Output (`--out-dir`, default `/tmp/alexa-local-inspector-live/`)

`events.jsonl` (every event, append-only), `tools.json`, `tool-result.json`,
`state.json`, `inspection-summary.json`, `certification-verdict.json`,
`transcript.md`, `screenshots/`, `widgets/` — and a copy of all of it in
`sessions/<started>/` when the run finishes, so nothing is overwritten.
Tokens never appear in any file; long strings (page tokens) are shortened.

## Verdict

`certification-verdict.json` lists each rule as PASS / WARN / FAIL with evidence:
handshake, tool count/names/schemas/descriptions, stable listing, scripted
turns, ≤ 5 options, speech length, no ids, bare 401, p95 ≤ 500 ms, no 5xx,
PRM resource, RFC 8414 (S256 + `client_credentials`), linking, and — for tools
with a `ui://` resource — a screenshot per surface with overflow / font-size /
tap-target checks. Verdict: `CERTIFIED`, `CONDITIONAL` (warnings) or
`NOT_CERTIFIED` (any failure).

## Visual mode

`--visual` (or the UI's **Visual** button) reads each widget's HTML with
`resources/read`, hosts it in `ui/device-frame.html` (a host bridge for the MCP
Apps postMessage protocol that routes `tools/call` through the proxy), and
screenshots it on the small (1024×600) and large (1280×800) surfaces.
`npm install playwright && npx playwright install chromium` first. Voice-only
tools have no widget and are skipped.

## Tests

`npm test` — node:test against an in-process fake Alexa-profile server and a
fake authorization server; no network.

## Differences from Amazon's inspector (as documented 2026-10-14)

| Amazon                                         | Here                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `@alexa-ai/addon-local-inspector` (private)    | this package, MIT                                                     |
| agent-driven only                              | agent-driven **or** scripted / Claude-driven conversations             |
| no transcript                                  | `transcript.md` + `events.jsonl` + per-run archive                    |
| `initialize` with `2025-06-18`                 | `2025-11-25` by default (what the Alexa+ docs state), flag to change   |
| token source undocumented                      | `--token-env` / `--token-file` / built-in account linking              |
| output in `/tmp/alexaplus-addon-local-inspector-live/` | `/tmp/alexa-local-inspector-live/` (same file names)          |
