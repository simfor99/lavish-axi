import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { canonicalFile, canonicalizeUrl, isHttpUrl, SessionStore } from "../src/session-store.js";
import { rewriteHtmlAttributes, transformProxyHtml } from "../src/html-transform.js";
import { serve } from "../src/server.js";

test("isHttpUrl identifies http and https URLs and rejects file paths", () => {
  assert.equal(isHttpUrl("http://127.0.0.1:8000/setup"), true);
  assert.equal(isHttpUrl("https://example.com/app"), true);
  assert.equal(isHttpUrl("HTTP://LOCALHOST:3000/"), true);
  assert.equal(isHttpUrl("/home/user/page.html"), false);
  assert.equal(isHttpUrl("relative/page.html"), false);
  assert.equal(isHttpUrl(null), false);
  assert.equal(isHttpUrl(undefined), false);
  assert.equal(isHttpUrl(123), false);
});

test("canonicalizeUrl normalizes hostnames, trailing slashes, fragments, and query parameter order", () => {
  assert.equal(canonicalizeUrl("http://127.0.0.1:8000/setup"), "http://localhost:8000/setup");
  assert.equal(canonicalizeUrl("http://localhost:8000/setup"), "http://localhost:8000/setup");
  assert.equal(canonicalizeUrl("http://127.0.0.1:8000/setup/"), "http://localhost:8000/setup");
  assert.equal(canonicalizeUrl("HTTP://LOCALHOST:8000/setup#tab"), "http://localhost:8000/setup");
  assert.equal(canonicalizeUrl("http://localhost:8000/setup?b=2&a=1"), "http://localhost:8000/setup?a=1&b=2");
  assert.equal(canonicalizeUrl("http://127.0.0.1:8000/setup?a=1&b=2#section"), "http://localhost:8000/setup?a=1&b=2");
});

test("canonicalFile normalizes HTTP URLs through canonicalizeUrl", async () => {
  const url = "http://127.0.0.1:8000/setup?b=2&a=1#tab";
  const result = await canonicalFile(url);
  assert.equal(result, "http://localhost:8000/setup?a=1&b=2");
});

test("rewriteHtmlAttributes rewrites root-relative URLs and preserves external/safe ones", () => {
  const prefix = "/artifact/testkey/proxy";
  const inputHtml = `
    <link rel="stylesheet" href="/static/style.css">
    <script src="/static/bundle.js"></script>
    <form action="/api/submit" method="POST"></form>
    <a href="https://example.com/external">External</a>
    <img src="//cdn.example.com/logo.png">
    <a href="#hash">Hash</a>
    <script src="/sdk.js?key=testkey"></script>
    <iframe src="/artifact/testkey/sub.html"></iframe>
  `;

  const output = rewriteHtmlAttributes(inputHtml, prefix);
  assert.match(output, /href="\/artifact\/testkey\/proxy\/static\/style\.css"/);
  assert.match(output, /src="\/artifact\/testkey\/proxy\/static\/bundle\.js"/);
  assert.match(output, /action="\/artifact\/testkey\/proxy\/api\/submit"/);
  assert.match(output, /href="https:\/\/example\.com\/external"/);
  assert.match(output, /src="\/\/cdn\.example\.com\/logo\.png"/);
  assert.match(output, /href="#hash"/);
  assert.match(output, /src="\/sdk\.js\?key=testkey"/);
  assert.match(output, /src="\/artifact\/testkey\/sub\.html"/);
});

test("transformProxyHtml injects base tag, bootstrap script, and Lavish SDK", () => {
  const inputHtml = `<!doctype html><html><head><title>App</title></head><body><h1>Content</h1></body></html>`;
  const transformed = transformProxyHtml(inputHtml, "key123", "http://127.0.0.1:8000/setup", 1, "tok-1");

  assert.match(transformed, /<base href="\/artifact\/key123\/proxy\/setup">/);
  assert.match(transformed, /window\.localStorage/);
  assert.match(transformed, /window\.fetch/);
  assert.match(transformed, /XMLHttpRequest\.prototype\.open/);
  assert.match(transformed, /history\.pushState/);
  assert.match(
    transformed,
    /<script src="\/sdk\.js\?key=key123&artifact_revision=1&artifact_load_token=tok-1"><\/script><\/body>/,
  );
});

test("Lavish server URL proxy mode: end-to-end session, iframe sandbox, index proxy, and API forwarding", async () => {
  // 1. Create a mock target upstream HTTP server
  let receivedApiBody = null;
  let receivedHeaders = null;
  const targetServer = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    if (req.url === "/setup" || req.url === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'self'",
        "x-frame-options": "DENY",
      });
      res.end(`<!doctype html>
<html>
<head><title>Mock Upstream App</title><link rel="stylesheet" href="/assets/style.css"></head>
<body><div id="root">Hello Upstream</div><script src="/assets/app.js"></script></body>
</html>`);
      return;
    }
    if (req.url === "/assets/style.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end("body { background: #fafafa; }");
      return;
    }
    if (req.url === "/api/tasks/apply" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        receivedApiBody = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "success", count: receivedApiBody.tasks?.length || 0 }));
      });
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise((resolve) => targetServer.listen(0, "127.0.0.1", () => resolve(undefined)));
  const addr = /** @type {import("node:net").AddressInfo} */ (targetServer.address());
  const targetPort = addr.port;
  const targetUrl = `http://127.0.0.1:${targetPort}/setup`;

  // 2. Start Lavish server
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "lavish-proxy-test-"));
  const stateFilePath = path.join(tempDir, "state.json");
  const lavish = await serve({ port: 0, stateFile: stateFilePath, version: "0.1.70" });
  const lavishPort = lavish.port;
  const lavishBase = `http://127.0.0.1:${lavishPort}`;

  try {
    // 3. Create proxy session via POST /api/sessions
    const sessionRes = await fetch(`${lavishBase}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: targetUrl }),
    });
    assert.equal(sessionRes.status, 200);
    const sessionData = await sessionRes.json();
    assert.equal(sessionData.status, "opened");
    const key = sessionData.key;
    assert.ok(key);

    // Verify session store preserved is_proxy
    const store = new SessionStore(stateFilePath);
    const stored = await store.findByKey(key);
    assert.equal(stored.is_proxy, true);
    assert.equal(stored.target_url, targetUrl);

    // Verify duplicate session detection across localhost/127.0.0.1 aliases and trailing slash
    const dupRes = await fetch(`${lavishBase}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: `http://localhost:${targetPort}/setup/` }),
    });
    const dupData = await dupRes.json();
    assert.equal(dupData.key, key, "Duplicate URL variation must resolve to the identical session key");

    // 4. Request chrome page GET /session/:key and check iframe sandbox has allow-same-origin for loopback
    const chromeRes = await fetch(`${lavishBase}/session/${key}`);
    assert.equal(chromeRes.status, 200);
    const chromeHtml = await chromeRes.text();
    assert.match(
      chromeHtml,
      /<iframe id="artifact" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"/,
    );
    assert.match(chromeHtml, /<title>Mock Upstream App · Lavish<\/title>/);

    // 5. Request GET /artifact/:key/index.html?direct=1
    const artifactRes = await fetch(`${lavishBase}/artifact/${key}/index.html?direct=1`);
    assert.equal(artifactRes.status, 200);
    // CSP must include allow-same-origin for loopback
    assert.match(artifactRes.headers.get("content-security-policy"), /allow-same-origin/);
    const artifactHtml = await artifactRes.text();
    // Injected base tag matches current subpage
    assert.match(artifactHtml, new RegExp(`<base href="/artifact/${key}/proxy/setup">`));
    // Injected storage and fetch interceptor
    assert.match(artifactHtml, /window\.localStorage/);
    assert.match(artifactHtml, /window\.fetch/);
    // Rewritten asset links
    assert.match(artifactHtml, new RegExp(`href="/artifact/${key}/proxy/assets/style.css"`));
    assert.match(artifactHtml, new RegExp(`src="/artifact/${key}/proxy/assets/app.js"`));
    // Injected Lavish SDK
    assert.match(artifactHtml, new RegExp(`<script src="/sdk\\.js\\?key=${key}`));

    // 5b. Verify export and share routes reject proxy sessions with 409 Conflict
    const exportRes = await fetch(`${lavishBase}/api/${key}/export`);
    assert.equal(exportRes.status, 409);
    const shareRes = await fetch(`${lavishBase}/api/${key}/share`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: lavishBase },
      body: JSON.stringify({}),
    });
    assert.equal(shareRes.status, 409);

    // 6. Test sub-resource proxying: GET /artifact/:key/proxy/assets/style.css
    const cssRes = await fetch(`${lavishBase}/artifact/${key}/proxy/assets/style.css`);
    assert.equal(cssRes.status, 200);
    assert.equal(cssRes.headers.get("content-type"), "text/css");
    const cssBody = await cssRes.text();
    assert.equal(cssBody, "body { background: #fafafa; }");

    // 6b. Test cross-origin proxy rejection: returns 400 Bad Request
    const crossOriginRes = await fetch(`${lavishBase}/artifact/${key}/proxy/https://evil.com/leak`);
    assert.equal(crossOriginRes.status, 400);

    // 7. Test API proxying: POST /artifact/:key/proxy/api/tasks/apply
    const apiPayload = { tasks: [{ id: 1, title: "Task 1" }] };
    const apiRes = await fetch(`${lavishBase}/artifact/${key}/proxy/api/tasks/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(apiPayload),
    });
    assert.equal(apiRes.status, 200);
    const apiData = await apiRes.json();
    assert.deepEqual(apiData, { status: "success", count: 1 });
    assert.deepEqual(receivedApiBody, apiPayload);
    assert.ok(receivedHeaders);
    assert.equal(receivedHeaders["x-forwarded-host"], `127.0.0.1:${lavishPort}`);

    // 8. Test fallback sub-resource redirection: GET /artifact/:key/assets/style.css
    const fallbackRes = await fetch(`${lavishBase}/artifact/${key}/assets/style.css`, {
      redirect: "manual",
    });
    assert.equal(fallbackRes.status, 302);
    assert.equal(fallbackRes.headers.get("location"), `/artifact/${key}/proxy/assets/style.css`);

    // 9. Close target server to simulate upstream crash/outage
    await new Promise((resolve) => targetServer.close(resolve));

    // Test proxy endpoint returns 502 Bad Gateway instead of 500 unhandled crash
    const offlineProxyRes = await fetch(`${lavishBase}/artifact/${key}/proxy/api/test`);
    assert.equal(offlineProxyRes.status, 502);
    const offlineProxyJson = await offlineProxyRes.json();
    assert.equal(offlineProxyJson.error, "Bad Gateway");

    // Test index.html returns graceful App Offline card instead of crashing
    const offlineIndexRes = await fetch(`${lavishBase}/artifact/${key}/index.html?direct=1`);
    assert.equal(offlineIndexRes.status, 200);
    const offlineIndexHtml = await offlineIndexRes.text();
    assert.match(offlineIndexHtml, /Target Server Unreachable/);
  } finally {
    if (lavish) await lavish.close();
    targetServer.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("openCommand rejects recursive self-wrapping of Lavish session URLs", async () => {
  const { openCommand } = await import("../src/cli.js");
  await assert.rejects(
    async () => {
      await openCommand(["http://localhost:4387/session/32555cd1d1032689?annotate=off"]);
    },
    (/** @type {any} */ err) => {
      assert.match(err.message, /Cannot wrap an existing Lavish review session/);
      return true;
    },
  );
});
