// Account linking the way Alexa+ does it: read the server's Protected
// Resource Metadata, follow it to the authorization server's RFC 8414
// metadata, run authorization code + PKCE (S256) with a loopback redirect,
// and exchange the code. Every hop is recorded (documents, scopes requested
// vs granted, the `resource` parameter) — the evidence for the scope-naming
// questions in docs/alexa-scopes.md. Tokens are never printed.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const LOOPBACK_PORT = 8976;
export const REDIRECT_URI = `http://localhost:${LOOPBACK_PORT}/callback`;

/** PRM location for a resource URL: path-aware first (RFC 9728 §3), then the root. */
export function prmCandidates(resource) {
  const url = new URL(resource);
  const path = url.pathname.replace(/\/$/u, "");
  const list = [];
  if (path && path !== "/") list.push(`${url.origin}/.well-known/oauth-protected-resource${path}`);
  list.push(`${url.origin}/.well-known/oauth-protected-resource`);
  return list;
}

export function asMetadataCandidates(issuer) {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/u, "");
  const list = [`${url.origin}/.well-known/oauth-authorization-server${path}`];
  if (path) list.push(`${url.origin}${path}/.well-known/oauth-authorization-server`);
  list.push(`${url.origin}/.well-known/openid-configuration${path}`);
  return [...new Set(list)];
}

async function fetchJson(url, fetchImpl) {
  const started = performance.now();
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000)
  });
  const ms = Math.round((performance.now() - started) * 10) / 10;
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { url, status: response.status, ms, json };
}

/** Discover PRM and AS metadata for an MCP resource; records every attempt. */
export async function discover(resource, { fetchImpl = fetch } = {}) {
  const attempts = [];
  let prm;
  for (const url of prmCandidates(resource)) {
    const hop = await fetchJson(url, fetchImpl);
    attempts.push(hop);
    if (hop.status === 200 && hop.json?.resource) {
      prm = hop.json;
      break;
    }
  }
  if (!prm) return { attempts, prm: undefined, as: undefined };
  const issuer = prm.authorization_servers?.[0];
  let as;
  if (issuer)
    for (const url of asMetadataCandidates(issuer)) {
      const hop = await fetchJson(url, fetchImpl);
      attempts.push(hop);
      if (hop.status === 200 && hop.json?.token_endpoint) {
        as = hop.json;
        break;
      }
    }
  return { attempts, prm, as, issuer };
}

export function pkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Run the linking flow. `openUrl(url)` is called with the authorize URL (the
 * caller opens a browser or shows it). Resolves with the token record once
 * the loopback callback has been hit and the code exchanged.
 */
export async function link({
  resource,
  clientId,
  clientSecret,
  scope,
  discovery,
  openUrl,
  tokenFile,
  fetchImpl = fetch,
  timeoutMs = 300_000,
  redirectUri = REDIRECT_URI,
  onEvent = () => {}
}) {
  const found = discovery ?? (await discover(resource, { fetchImpl }));
  if (!found.prm) throw new Error("no Protected Resource Metadata found for the server");
  if (!found.as) throw new Error("no authorization-server metadata found (RFC 8414)");
  const scopes = scope ?? (found.prm.scopes_supported ?? []).join(" ");
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("hex");
  const authorize = new URL(found.as.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource
  }))
    authorize.searchParams.set(key, value);
  onEvent({
    phase: "authorize",
    authorizationEndpoint: found.as.authorization_endpoint,
    tokenEndpoint: found.as.token_endpoint,
    scopesRequested: scopes.split(" ").filter(Boolean),
    resource,
    pkce: "S256",
    redirectUri
  });

  const port = Number(new URL(redirectUri).port);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`no callback within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);
      if (url.pathname !== "/callback") return response.writeHead(404).end();
      if (url.searchParams.get("state") !== state)
        return response.writeHead(400).end("state mismatch");
      const code = url.searchParams.get("code");
      if (!code) {
        const error = url.searchParams.get("error") ?? "no code";
        response.writeHead(400).end(error);
        clearTimeout(timer);
        server.close();
        return reject(new Error(`authorization failed: ${error}`));
      }
      const started = performance.now();
      const token = await fetchImpl(found.as.token_endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource
        }),
        signal: AbortSignal.timeout(15_000)
      });
      const ms = Math.round((performance.now() - started) * 10) / 10;
      const body = await token.json().catch(() => ({}));
      clearTimeout(timer);
      server.close();
      if (!token.ok || !body.access_token) {
        response.writeHead(502).end("token exchange failed; see the inspector");
        return reject(
          new Error(
            `token exchange failed: ${token.status} ${body.error ?? ""} ${body.error_description ?? ""}`.trim()
          )
        );
      }
      if (tokenFile) {
        mkdirSync(dirname(tokenFile), { recursive: true });
        writeFileSync(tokenFile, body.access_token, { mode: 0o600 });
      }
      response.end("Account linked. You can close this tab and return to the inspector.");
      const record = {
        phase: "linked",
        tokenEndpointStatus: token.status,
        tokenExchangeMs: ms,
        tokenType: body.token_type,
        expiresIn: body.expires_in,
        scopesGranted: body.scope ? body.scope.split(" ") : undefined,
        refreshToken: Boolean(body.refresh_token),
        claims: decodeClaims(body.access_token)
      };
      onEvent(record);
      resolve({ accessToken: body.access_token, ...record, discovery: found });
    });
    server.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.listen(port, "localhost", () => openUrl(authorize.toString()));
  });
}

/** Non-sensitive JWT claims (no signature check: evidence only). */
export function decodeClaims(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const { iss, aud, client_id, scope, token_use, exp, iat } = payload;
    return { iss, aud, client_id, scope, token_use, exp, iat };
  } catch {
    return undefined;
  }
}
