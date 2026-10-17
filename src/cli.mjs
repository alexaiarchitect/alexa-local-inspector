// alexa-local-inspector <server-url> [options]            start proxy (:6277) + UI (:6274)
// alexa-local-inspector drive <server-url> --script F     run a scripted conversation, record, verdict, exit
// alexa-local-inspector link <server-url>                 account linking only (prints nothing secret)
// alexa-local-inspector verdict <server-url>              handshake + metadata + verdict, no conversation
// alexa-local-inspector report [--out-dir D]              re-render transcript.md from state.json
//
// Options: --server-port 6277 --client-port 6274 --locale en-US --protocol-version 2025-11-25
//   --token-env MCP_TOKEN --token-file F --meta-locale --out-dir /tmp/alexa-local-inspector-live
//   --script F --brain none|claude --model claude-sonnet-5-5 --visual --no-open --verbose
//   --client-id ID (or ALEXA_CLIENT_ID) ; the client secret only from ALEXA_CLIENT_SECRET
// Exit code: 0 when the conversation passed (drive) / the verdict is not NOT_CERTIFIED, 1 otherwise, 2 on usage.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { Inspector } from "./inspector.mjs";
import { createProxyServer, createUiServer, listen } from "./proxy.mjs";
import { renderTranscript } from "./transcript.mjs";
import { DEFAULT_OUT_DIR } from "./recorder.mjs";

const COMMANDS = new Set(["serve", "drive", "link", "verdict", "report"]);

export function parseArgs(argv) {
  const options = {
    command: "serve",
    serverPort: 6277,
    clientPort: 6274,
    locale: "en-US",
    protocolVersion: "2025-11-25",
    tokenEnv: "MCP_TOKEN",
    outDir: DEFAULT_OUT_DIR,
    brain: "none",
    metaLocale: false,
    visual: false,
    open: true,
    verbose: false
  };
  const named = {
    "--server-port": ["serverPort", Number],
    "--client-port": ["clientPort", Number],
    "--locale": ["locale", String],
    "--protocol-version": ["protocolVersion", String],
    "--token-env": ["tokenEnv", String],
    "--token-file": ["tokenFile", String],
    "--out-dir": ["outDir", String],
    "--script": ["script", String],
    "--brain": ["brain", String],
    "--model": ["model", String],
    "--client-id": ["clientId", String],
    "--scope": ["scope", String]
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--meta-locale") options.metaLocale = true;
    else if (arg === "--visual") options.visual = true;
    else if (arg === "--no-open") options.open = false;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (named[arg]) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      options[named[arg][0]] = named[arg][1](value);
      i += 1;
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length && COMMANDS.has(positional[0])) options.command = positional.shift();
  options.serverUrl = positional.shift();
  if (positional.length) throw new Error(`unexpected argument ${positional[0]}`);
  if (options.command !== "report" && !options.serverUrl && !options.help)
    throw new Error("server URL required (http://127.0.0.1:8787/mcp or https://host/mcp)");
  if (!["none", "claude"].includes(options.brain)) throw new Error("--brain is none or claude");
  if (!/^[a-z]{2}-[A-Z]{2}$/u.test(options.locale)) throw new Error("--locale looks like en-US");
  if (options.command === "drive" && !options.script) throw new Error("drive needs --script F");
  return options;
}

function readToken(options, env = process.env) {
  if (env[options.tokenEnv]) return { token: env[options.tokenEnv].trim(), source: `$${options.tokenEnv}` };
  if (options.tokenFile) {
    const path = resolve(options.tokenFile);
    if (existsSync(path)) return { token: readFileSync(path, "utf8").trim(), source: options.tokenFile };
  }
  return { token: undefined, source: undefined };
}

function openInBrowser(url, log) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    log(`open this URL: ${url}`);
  }
}

function usage() {
  return readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(0, 11).map((l) => l.replace(/^\/\/ ?/u, "")).join("\n");
}

export async function main(argv, { log = console.log, error = console.error, env = process.env } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (e) {
    error(`alexa-local-inspector: ${e.message}`);
    return 2;
  }
  if (options.help) {
    log(usage());
    return 0;
  }
  if (options.command === "report") {
    const statePath = join(options.outDir, "state.json");
    if (!existsSync(statePath)) {
      error(`no state.json in ${options.outDir}`);
      return 2;
    }
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const out = join(options.outDir, "transcript.md");
    writeFileSync(out, renderTranscript(state));
    log(`transcript written to ${out}`);
    return 0;
  }

  const { token, source } = readToken(options, env);
  let inspector;
  try {
    inspector = new Inspector({
      serverUrl: options.serverUrl,
      token,
      tokenSource: source,
      locale: options.locale,
      metaLocale: options.metaLocale,
      protocolVersion: options.protocolVersion,
      outDir: options.outDir,
      verbose: options.verbose,
      log
    });
  } catch (e) {
    error(`alexa-local-inspector: ${e.message}`);
    return 2;
  }
  await inspector.start();
  if (!token) log("no token: pass --token-env/--token-file or link the account (authenticated calls will get 401)");

  const linkConfig = () => {
    const clientId = options.clientId ?? env.ALEXA_CLIENT_ID;
    const clientSecret = env.ALEXA_CLIENT_SECRET;
    if (!clientId || !clientSecret) return undefined;
    return { clientId, clientSecret, scope: options.scope };
  };
  const doLink = async () => {
    const config = linkConfig();
    if (!config) throw new Error("set ALEXA_CLIENT_ID (or --client-id) and ALEXA_CLIENT_SECRET");
    let authorizeUrl;
    const done = inspector.linkAccount({
      ...config,
      tokenFile: options.tokenFile,
      openUrl: (url) => {
        authorizeUrl = url;
        log("account linking: sign in in the browser (authorize URL opened)");
        if (options.open) openInBrowser(url, log);
        else log(url);
      }
    });
    // Give the loopback server a tick to start and the authorize URL to be built.
    await new Promise((r) => setTimeout(r, 50));
    return { authorizeUrl, done };
  };

  if (options.command === "link") {
    try {
      const { done } = await doLink();
      await done;
      log(`linked; scopes granted: ${(inspector.link.scopesGranted ?? []).join(" ") || "(not echoed)"}`);
      inspector.finish();
      return 0;
    } catch (e) {
      error(`alexa-local-inspector: ${e.message}`);
      inspector.finish();
      return 1;
    }
  }

  if (options.command === "verdict" || options.command === "drive") {
    let code = 0;
    try {
      await inspector.handshake();
      await inspector.listTools();
      if (options.command === "drive") {
        const conversation = await inspector.drive({
          script: options.script,
          brain: options.brain,
          model: options.model
        });
        for (const turn of conversation.turns)
          log(`${turn.pass ? "PASS" : "FAIL"} ${String(turn.n).padStart(2)}. ${turn.say}\n        → ${turn.alexaSays}`);
        const s = conversation.summary;
        log(`\n${s.verdict}: ${s.passed}/${s.turns} turns; p50 ${s.p50Ms} ms, p95 ${s.p95Ms} ms; handshake ${inspector.session.handshake.totalMs} ms`);
        for (const w of conversation.warnings) log(`warning: ${w}`);
        if (s.verdict !== "PASS") code = 1;
      }
      if (options.visual) {
        const proxy = createProxyServer(inspector, {});
        const port = await listen(proxy, 0);
        const { screenshotWidgets } = await import("./visual.mjs");
        const shots = await screenshotWidgets(inspector, { proxyPort: port });
        log(`screenshots: ${shots.length}`);
        proxy.close();
      }
    } catch (e) {
      error(`alexa-local-inspector: ${e.message}`);
      code = 1;
    }
    const verdict = inspector.evaluateVerdict();
    const { sessionDir } = inspector.finish();
    log(`verdict ${verdict.verdict} (${verdict.counts.pass} pass, ${verdict.counts.warn} warn, ${verdict.counts.fail} fail) → ${inspector.recorder.outDir} (archived in ${sessionDir})`);
    return code || (verdict.verdict === "NOT_CERTIFIED" ? 1 : 0);
  }

  // serve: proxy + UI until Ctrl-C
  const proxy = createProxyServer(inspector, {
    clientPort: options.clientPort,
    onLink: () => doLink(),
    onVisual: async () => {
      const { screenshotWidgets } = await import("./visual.mjs");
      return screenshotWidgets(inspector, { proxyPort: options.serverPort });
    }
  });
  const ui = createUiServer({ serverPort: options.serverPort });
  try {
    await listen(proxy, options.serverPort);
    await listen(ui, options.clientPort);
  } catch (e) {
    error(`alexa-local-inspector: cannot listen: ${e.message}`);
    return 2;
  }
  const uiUrl = `http://localhost:${options.clientPort}/`;
  log(`proxy    http://127.0.0.1:${options.serverPort}/mcp  →  ${options.serverUrl}`);
  log(`ui       ${uiUrl}`);
  log(`records  ${options.outDir}`);
  if (options.open) openInBrowser(uiUrl, log);
  await new Promise((resolveStop) => {
    const stop = () => {
      log("\nfinishing…");
      const { sessionDir } = inspector.finish();
      log(`archived in ${sessionDir}`);
      proxy.close();
      ui.close();
      resolveStop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
