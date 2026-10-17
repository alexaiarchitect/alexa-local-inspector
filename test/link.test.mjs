import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeServer } from "./fake-server.mjs";
import { asMetadataCandidates, decodeClaims, discover, link, pkcePair, prmCandidates } from "../src/link.mjs";

test("metadata candidates follow RFC 9728 / 8414 ordering", () => {
  assert.deepEqual(prmCandidates("https://h/mcp"), ["https://h/.well-known/oauth-protected-resource/mcp", "https://h/.well-known/oauth-protected-resource"]);
  assert.equal(asMetadataCandidates("https://h")[0], "https://h/.well-known/oauth-authorization-server");
  assert.equal(asMetadataCandidates("https://h/issuer")[0], "https://h/.well-known/oauth-authorization-server/issuer");
});

test("pkce pair and claims decoding", () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length > 40 && challenge.length === 43);
  const claims = decodeClaims("x." + Buffer.from(JSON.stringify({ iss: "i", client_id: "c", secret: "no" })).toString("base64url") + ".y");
  assert.deepEqual(Object.keys(claims).filter((k) => claims[k] !== undefined), ["iss", "client_id"]);
});

test("discover and link against the fake authorization server", async () => {
  const fake = await startFakeServer();
  const found = await discover(fake.url);
  assert.equal(found.prm.resource, fake.url);
  assert.equal(found.as.grant_types_supported.length, 3);
  assert.ok(found.attempts.length >= 2);

  const events = [];
  const redirectUri = "http://localhost:18976/callback";
  const result = await link({
    resource: fake.url,
    clientId: "c1",
    clientSecret: "s1",
    discovery: found,
    redirectUri,
    onEvent: (e) => events.push(e),
    openUrl: async (url) => {
      const authorize = new URL(url);
      assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
      assert.equal(authorize.searchParams.get("resource"), fake.url);
      assert.equal(authorize.searchParams.get("redirect_uri"), redirectUri);
      // the "user" signs in: the AS redirects back to the loopback
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "good-code");
      callback.searchParams.set("state", authorize.searchParams.get("state"));
      await fetch(callback);
    }
  });
  assert.equal(result.phase, "linked");
  assert.ok(result.accessToken);
  assert.deepEqual(result.scopesGranted, ["categories.read"]);
  assert.equal(events[0].phase, "authorize");
  assert.deepEqual(events[0].scopesRequested, found.prm.scopes_supported);
  const tokenCall = fake.calls.find((c) => c.method === "oauth2/token");
  assert.equal(tokenCall.grant, "authorization_code");
  assert.equal(tokenCall.resource, fake.url);
  assert.equal(tokenCall.verifier, true);
  assert.match(tokenCall.auth, /^Basic /u);
  await fake.close();
});
