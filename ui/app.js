/* Read-mostly UI over the proxy's /events stream. Vanilla JS, no build step. */
(() => {
  "use strict";
  const API = window.INSPECTOR_API;
  const $ = (id) => document.getElementById(id);
  const state = { calls: [], tools: [], conversation: null, link: null, verdict: null, screenshots: [] };
  const params = new URLSearchParams(location.search);
  if (params.get("popout") === "1") {
    document.body.classList.add("popout");
    show(params.get("panel") || "device");
  }

  // ---- helpers
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const child of children) if (child != null) node.append(child);
    return node;
  };
  const pre = (value) => el("pre", { class: "mono", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
  const dl = (pairs) => {
    const grid = el("dl", { class: "grid" });
    for (const [k, v] of pairs) grid.append(el("dt", { text: k }), el("dd", {}, typeof v === "string" ? v : v ?? ""));
    return grid;
  };
  const log = (message) => {
    const line = el("div", { text: `${new Date().toLocaleTimeString()}  ${message}` });
    $("log").prepend(line);
  };
  const post = async (path, body) => {
    const response = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
    return json;
  };
  function show(name) {
    for (const button of document.querySelectorAll("#tabs button")) button.classList.toggle("active", button.dataset.panel === name);
    for (const panel of document.querySelectorAll(".panel")) panel.classList.toggle("active", panel.id === `panel-${name}`);
  }
  for (const button of document.querySelectorAll("#tabs button")) button.addEventListener("click", () => show(button.dataset.panel));

  // ---- renderers
  function renderSession() {
    const s = state.session || {};
    const panel = $("panel-session");
    panel.replaceChildren(
      el("div", { class: "card" },
        el("h2", { text: "Server" }),
        dl([
          ["URL", el("code", { text: state.serverUrl || "" })],
          ["Status", state.status || ""],
          ["Token", state.tokenPresent ? `present (${state.tokenSource})` : "none — link the account or pass --token-file"],
          ["Protocol", s.protocolVersion ? `requested ${s.requestedProtocolVersion}, negotiated ${s.protocolVersion}` : "no handshake yet"],
          ["Server info", s.serverInfo ? `${s.serverInfo.title || s.serverInfo.name || ""} ${s.serverInfo.version || ""}` : ""],
          ["Capabilities", (s.capabilities || []).join(", ")],
          ["Session", s.protocolVersion ? (s.sessionId ? "Mcp-Session-Id issued" : "stateless") : ""],
          ["Handshake", s.handshake ? `${s.handshake.totalMs} ms (${s.handshake.steps.map((x) => `${x.step} ${x.status}/${x.ms} ms`).join(", ")})` : ""],
          ["Records", el("code", { text: state.outDir || "" })]
        ])),
      el("div", { class: "card" },
        el("h2", { text: "Authorization metadata" }),
        state.metadata ? dl([
          ["PRM resource", state.metadata.prm?.resource || "(none)"],
          ["Authorization servers", (state.metadata.prm?.authorization_servers || []).join(", ")],
          ["Scopes supported", (state.metadata.prm?.scopes_supported || []).join("  ")],
          ["Authorize endpoint", state.metadata.as?.authorization_endpoint || "(none)"],
          ["Token endpoint", state.metadata.as?.token_endpoint || "(none)"],
          ["Grants", (state.metadata.as?.grant_types_supported || []).join(", ")],
          ["PKCE", (state.metadata.as?.code_challenge_methods_supported || []).join(", ")]
        ]) : el("p", { class: "muted", text: "not fetched" })),
      el("div", { class: "card" },
        el("h2", { text: "Account linking" }),
        state.link ? dl([
          ["Status", el("span", { class: state.link.status === "linked" ? "ok" : state.link.status === "failed" ? "bad" : "warn", text: state.link.status })],
          ["Scopes requested", (state.link.scopesRequested || []).join("  ")],
          ["Scopes granted", (state.link.scopesGranted || []).join("  ") || "(not echoed)"],
          ["Token claims", state.link.claims ? pre(state.link.claims) : ""],
          ["Error", state.link.error || ""]
        ]) : el("p", { class: "muted", text: "not started" })),
      state.errors?.length ? el("div", { class: "card" }, el("h2", { text: "Errors" }), pre(state.errors)) : null
    );
  }
  function renderTools() {
    const panel = $("panel-tools");
    panel.replaceChildren(
      el("p", { class: "muted", text: state.tools.length ? `${state.tools.length} tools${state.toolsStable === undefined ? "" : state.toolsStable ? " · stable across listings" : " · CHANGED between listings"}` : "no tools/list yet" }),
      ...state.tools.map((tool) => el("details", { class: "card" },
        el("summary", {}, el("code", { text: tool.name }), " — ", tool.title || "", widgetUri(tool) ? el("span", { class: "muted", text: `  [widget ${widgetUri(tool)}]` }) : null),
        el("p", { text: tool.description || "" }),
        pre(tool.inputSchema || {})))
    );
    const select = $("device-tool");
    select.replaceChildren(...state.tools.filter(widgetUri).map((t) => el("option", { value: t.name, text: t.name })));
  }
  function renderConversation() {
    const panel = $("panel-conversation");
    const c = state.conversation;
    if (!c) return panel.replaceChildren(el("p", { class: "muted", text: "no conversation yet — choose a script and press Run" }));
    const s = c.summary;
    panel.replaceChildren(
      el("div", { class: "card" }, dl([
        ["Script", c.script], ["Locale", c.locale], ["Brain", c.brain],
        ["Progress", `${c.turns.length}/${c.total}`],
        ["Summary", s ? el("span", { class: s.verdict === "PASS" ? "ok" : "bad", text: `${s.verdict}: ${s.passed}/${s.turns} turns; p50 ${s.p50Ms} ms, p95 ${s.p95Ms} ms, max ${s.maxMs} ms` }) : "running…"],
        ["Warnings", (c.warnings || []).join("; ")]
      ])),
      ...c.turns.map((turn) => el("div", { class: `turn ${turn.pass ? "pass" : "fail"}` },
        el("div", { class: "say", text: `${turn.n}. ${turn.say}` }),
        ...turn.calls.map((call) => el("div", { class: "mono muted", text: `→ ${call.tool}${call.auth === false ? " (no token)" : ""} ${JSON.stringify(call.args)} → HTTP ${call.status}${call.isError ? " isError" : ""} · ${call.ms} ms` })),
        el("div", { class: "alexa", text: turn.alexaSays || "(nothing)" }),
        el("div", { class: "checks" }, ...turn.checks.map((x) => el("span", { class: x.ok ? "ok" : "bad", text: `${x.ok ? "✓" : "✗"} ${x.check}${x.detail && !x.ok ? ` (${x.detail})` : ""}` }))),
        turn.note ? el("div", { class: "muted", text: turn.note }) : null))
    );
  }
  function renderTimeline() {
    const panel = $("panel-timeline");
    const max = Math.max(500, ...state.calls.map((c) => c.ms || 0));
    const table = el("table", {}, el("thead", {}, el("tr", {}, ...["#", "Time", "Method", "Tool", "HTTP", "ms", "", "Detail"].map((h) => el("th", { text: h })))));
    const body = el("tbody");
    for (const call of [...state.calls].reverse()) {
      const row = el("tr", {},
        el("td", { text: call.seq }),
        el("td", { class: "mono muted", text: call.ts?.slice(11, 23) || "" }),
        el("td", {}, el("code", { text: call.method || "" })),
        el("td", {}, el("code", { text: call.name || "" })),
        el("td", { class: call.status >= 400 ? (call.status === 401 && !call.auth ? "warn" : "bad") : "ok", text: `${call.status}${call.auth ? "" : " (no token)"}${call.wwwAuthenticate ? " +WWW-Auth" : ""}` }),
        el("td", { text: call.ms }),
        el("td", {}, el("span", { class: `bar${call.ms > 500 ? " slow" : ""}`, style: `width:${Math.max(2, Math.round((call.ms / max) * 160))}px` })),
        el("td", {}, el("details", {}, el("summary", { text: call.isError ? "error" : "ok" }), pre({ request: call.request, response: call.response, headers: call.headers, failure: call.failure })))
      );
      body.append(row);
    }
    table.append(body);
    panel.replaceChildren(el("p", { class: "muted", text: `${state.calls.length} requests` }), table);
  }
  function renderVerdict() {
    const panel = $("panel-verdict");
    const v = state.verdict;
    if (!v) return panel.replaceChildren(el("p", { class: "muted", text: "press Verdict" }));
    const table = el("table", {}, el("thead", {}, el("tr", {}, ...["Rule", "Status", "Evidence"].map((h) => el("th", { text: h })))));
    const body = el("tbody");
    for (const r of v.rules)
      body.append(el("tr", {}, el("td", {}, r.title, " ", el("code", { class: "muted", text: r.id })), el("td", { class: r.status === "PASS" ? "ok" : r.status === "WARN" ? "warn" : "bad", text: r.status }), el("td", { text: r.evidence })));
    table.append(body);
    panel.replaceChildren(
      el("h2", { class: v.verdict === "CERTIFIED" ? "ok" : v.verdict === "CONDITIONAL" ? "warn" : "bad", text: `${v.verdict} — ${v.counts.pass} pass, ${v.counts.warn} warn, ${v.counts.fail} fail` }),
      table,
      state.screenshots.length ? el("div", { class: "card" }, el("h3", { text: "Screenshots" }), ...state.screenshots.map((s) => el("div", { class: "mono", text: `${s.tool} · ${s.surface} · ${s.file}${s.issues.length ? " — " + s.issues.join(", ") : ""}` }))) : null
    );
  }
  function renderDevice() {
    const tool = $("device-tool").value;
    const surface = document.querySelector(".surface.active")?.dataset.surface || "small";
    $("device-frame-wrap").classList.toggle("large", surface === "large");
    const frame = $("device-frame");
    if (!tool) { frame.removeAttribute("src"); return; }
    const url = new URL("/device-frame.html", location.origin);
    url.searchParams.set("tool", tool);
    url.searchParams.set("surface", surface);
    url.searchParams.set("api", API);
    frame.src = url.toString();
  }
  function widgetUri(tool) { return tool?._meta?.ui?.resourceUri || tool?._meta?.["ui/resourceUri"]; }
  function renderAll() { renderSession(); renderTools(); renderConversation(); renderTimeline(); renderVerdict(); }

  // ---- events
  const source = new EventSource(`${API}/events`);
  source.addEventListener("state", (e) => { Object.assign(state, JSON.parse(e.data)); $("server").textContent = `${state.serverUrl}  ·  proxy ${API}/mcp`; renderAll(); });
  source.addEventListener("call", (e) => { state.calls.push(JSON.parse(e.data)); renderTimeline(); });
  source.addEventListener("tools", (e) => { const d = JSON.parse(e.data); state.tools = d.tools; state.toolsStable = d.stable; renderTools(); });
  source.addEventListener("session", (e) => { state.session = JSON.parse(e.data); renderSession(); });
  source.addEventListener("token", (e) => { const d = JSON.parse(e.data); state.tokenPresent = d.present; state.tokenSource = d.source; renderSession(); });
  source.addEventListener("metadata", (e) => { state.metadata = JSON.parse(e.data); renderSession(); });
  source.addEventListener("link", (e) => { state.link = JSON.parse(e.data); renderSession(); log(`link: ${state.link.status}`); });
  source.addEventListener("conversation", (e) => { const d = JSON.parse(e.data); if (d.phase === "start") { state.conversation = { ...d, turns: [] }; show("conversation"); } else if (state.conversation) state.conversation.summary = d.summary; renderConversation(); });
  source.addEventListener("turn", (e) => { const d = JSON.parse(e.data); if (state.conversation) { state.conversation.turns.push(d.turn); renderConversation(); } });
  source.addEventListener("verdict", (e) => { state.verdict = JSON.parse(e.data); renderVerdict(); show("verdict"); });
  source.addEventListener("screenshot", (e) => { state.screenshots.push(JSON.parse(e.data)); renderVerdict(); });
  source.addEventListener("error", (e) => { if (e.data) log(`error: ${JSON.parse(e.data).message}`); });
  source.addEventListener("finished", (e) => log(`archived in ${JSON.parse(e.data).sessionDir}`));
  source.onerror = () => { $("server").textContent = "proxy not reachable — is alexa-local-inspector running?"; };

  // ---- actions
  const busy = async (button, fn) => { button.disabled = true; try { await fn(); } catch (error) { log(error.message); } finally { button.disabled = false; } };
  $("btn-handshake").addEventListener("click", (e) => busy(e.target, async () => { await post("/handshake"); log("handshake done"); }));
  $("btn-link").addEventListener("click", (e) => busy(e.target, async () => { const r = await post("/link"); log("authorize URL opened in your browser; sign in"); if (r.authorizeUrl) window.open(r.authorizeUrl, "_blank"); }));
  $("btn-drive").addEventListener("click", (e) => busy(e.target, async () => { const script = $("script").value.trim(); if (!script) throw new Error("enter a script path"); await post("/drive", { script, brain: $("brain").value }); }));
  $("btn-visual").addEventListener("click", (e) => busy(e.target, async () => { const shots = await post("/visual"); log(`${shots.length} screenshots`); }));
  $("btn-verdict").addEventListener("click", (e) => busy(e.target, async () => { await post("/verdict"); }));
  $("btn-finish").addEventListener("click", (e) => busy(e.target, async () => { const r = await post("/finish"); log(`finished: ${r.sessionDir}`); }));
  $("device-tool").addEventListener("change", renderDevice);
  for (const button of document.querySelectorAll(".surface")) button.addEventListener("click", () => { for (const b of document.querySelectorAll(".surface")) b.classList.toggle("active", b === button); renderDevice(); });
  document.querySelector('#tabs button[data-panel="device"]').addEventListener("click", renderDevice);
})();
