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
  assert.match(transformed, /var targetPath = "\/setup";/);
  assert.match(transformed, /window\.history\.replaceState\(window\.history\.state, "", targetPath\)/);
  assert.match(transformed, /history\.pushState/);
  assert.match(
    transformed,
    /<script src="\/sdk\.js\?key=key123&artifact_revision=1&artifact_load_token=tok-1"><\/script><\/body>/,
  );
});

test("transformProxyHtml strips upstream Content-Security-Policy and X-Frame-Options meta tags", () => {
  const inputHtml = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: https:;"><meta content="DENY" http-equiv="X-Frame-Options"><title>App</title></head><body><h1>Content</h1></body></html>`;
  const transformed = transformProxyHtml(inputHtml, "key123", "http://127.0.0.1:8000/setup", 1, "tok-1");

  assert.doesNotMatch(transformed, /content-security-policy/i);
  assert.doesNotMatch(transformed, /x-frame-options/i);
  assert.match(transformed, /<meta charset="utf-8">/);
  assert.match(transformed, /<title>App<\/title>/);
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

    // 8b. Test root-relative subresource redirection via Referer (ES modules / Vite / SPA assets)
    const refererRes = await fetch(`${lavishBase}/assets/style.css`, {
      headers: { referer: `${lavishBase}/artifact/${key}/proxy/setup` },
      redirect: "manual",
    });
    assert.equal(refererRes.status, 307);
    assert.equal(refererRes.headers.get("location"), `/artifact/${key}/proxy/assets/style.css`);

    // 8c. Test root-relative subresource redirection via Cookie fallback
    const cookieRes = await fetch(`${lavishBase}/assets/style.css`, {
      headers: { cookie: `lavish_proxy_session=${key}` },
      redirect: "manual",
    });
    assert.equal(cookieRes.status, 307);
    assert.equal(cookieRes.headers.get("location"), `/artifact/${key}/proxy/assets/style.css`);

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

test("Lavish session custom title persistence and chrome rendering", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "lavish-title-test-"));
  const stateFilePath = path.join(tempDir, "state.json");
  let lavish;
  try {
    lavish = await serve({ port: 0, stateFile: stateFilePath, version: "0.1.70" });
    const lavishBase = `http://127.0.0.1:${lavish.port}`;

    // 1. Open session with custom title
    const openRes = await fetch(`${lavishBase}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: "http://127.0.0.1:9999/app/audits/123",
        title: "Kundenfläche Stage 2a Reparatur",
      }),
    });
    assert.equal(openRes.status, 200);
    const openData = await openRes.json();
    assert.equal(openData.custom_title, "Kundenfläche Stage 2a Reparatur");

    // 2. Fetch chrome HTML and verify <title> and customTitle in session JSON
    const sessionRes = await fetch(`${lavishBase}/session/${openData.key}`);
    assert.equal(sessionRes.status, 200);
    const sessionHtml = await sessionRes.text();
    assert.match(sessionHtml, /<title>Kundenfläche Stage 2a Reparatur · Lavish<\/title>/);
    assert.match(sessionHtml, /"customTitle":"Kundenfläche Stage 2a Reparatur"/);

    // 3. Verify query parameter ?title= overrides title on the fly
    const overrideRes = await fetch(`${lavishBase}/session/${openData.key}?title=Adhoc+Title`);
    assert.equal(overrideRes.status, 200);
    const overrideHtml = await overrideRes.text();
    assert.match(overrideHtml, /<title>Adhoc Title · Lavish<\/title>/);
    assert.match(overrideHtml, /"customTitle":"Adhoc Title"/);
  } finally {
    if (lavish) await lavish.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("normalizeArgv and replyCommand accept HTTP(S) URLs and reuse-only rejects lifecycle commands", async () => {
  const { normalizeArgv, replyCommand, serverCommand, setupCommand, stopCommand } = await import("../src/cli.js");

  assert.deepEqual(normalizeArgv(["--title", "Audit", "https://example.com/app"]), [
    "open",
    "--title",
    "Audit",
    "https://example.com/app",
  ]);
  assert.deepEqual(normalizeArgv(["--no-open", "http://127.0.0.1:8000/setup"]), [
    "open",
    "--no-open",
    "http://127.0.0.1:8000/setup",
  ]);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "lavish-url-reply-test-"));
  const stateFilePath = path.join(tempDir, "state.json");
  let lavish;
  const previousEnv = {
    LAVISH_AXI_PORT: process.env.LAVISH_AXI_PORT,
    LAVISH_AXI_HOST: process.env.LAVISH_AXI_HOST,
    LAVISH_AXI_STATE_DIR: process.env.LAVISH_AXI_STATE_DIR,
    LAVISH_AXI_REUSE_ONLY: process.env.LAVISH_AXI_REUSE_ONLY,
  };
  try {
    const pkg = JSON.parse(
      await (await import("node:fs/promises")).readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    lavish = await serve({ port: 0, stateFile: stateFilePath, version: pkg.version });
    const lavishBase = `http://127.0.0.1:${lavish.port}`;
    const targetUrl = "http://127.0.0.1:9998/app/setup";
    const openRes = await fetch(`${lavishBase}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: targetUrl }),
    });
    assert.equal(openRes.status, 200);

    process.env.LAVISH_AXI_PORT = String(lavish.port);
    process.env.LAVISH_AXI_HOST = "127.0.0.1";
    process.env.LAVISH_AXI_STATE_DIR = tempDir;
    process.env.LAVISH_AXI_REUSE_ONLY = "1";

    const replyResult = await replyCommand([targetUrl, "--agent-reply", "Updated live route"]);
    assert.equal(replyResult.reply.status, "sent");
    assert.equal(replyResult.reply.file, "http://localhost:9998/app/setup");

    for (const entry of [
      { fn: stopCommand, args: [] },
      { fn: setupCommand, args: ["hooks"] },
      { fn: serverCommand, args: [] },
    ]) {
      await assert.rejects(
        async () => entry.fn(entry.args),
        (/** @type {any} */ err) => {
          assert.equal(err.code, "SERVER_ERROR");
          assert.match(err.message, /reuse-only mode/);
          return true;
        },
      );
    }
  } finally {
    for (const [k, v] of Object.entries(previousEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (lavish) await lavish.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("/health omits wildcard CORS and wrapped-favicon enforces same-origin and 256 KiB cap", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "lavish-favicon-guard-test-"));
  const stateFilePath = path.join(tempDir, "state.json");
  /** @type {import("node:http").Server | null} */
  let upstreamServer = null;
  /** @type {import("node:http").Server | null} */
  let foreignServer = null;
  let foreignRequests = 0;
  let iconMode = "foreign";
  let lavish;

  try {
    const foreign = http.createServer((_req, res) => {
      foreignRequests += 1;
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.from("foreign-icon"));
    });
    foreignServer = foreign;
    await new Promise((resolve) => foreign.listen(0, "127.0.0.1", () => resolve(undefined)));
    const foreignPort = /** @type {import("node:net").AddressInfo} */ (foreign.address()).port;

    const upstream = http.createServer((req, res) => {
      if (req.url === "/oversized.png") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(Buffer.alloc(300 * 1024, 0x41));
        return;
      }
      if (req.url === "/html-fallback.ico") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<!doctype html><html><body>Not an image</body></html>");
        return;
      }
      if (req.url === "/small.png") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        return;
      }
      const href =
        iconMode === "foreign"
          ? `http://127.0.0.1:${foreignPort}/leak.png`
          : iconMode === "oversized"
            ? "/oversized.png"
            : iconMode === "html"
              ? "/html-fallback.ico"
              : "/small.png";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><link rel="icon" href="${href}"></head><body><h1>App</h1></body></html>`);
    });
    upstreamServer = upstream;
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", () => resolve(undefined)));
    const upstreamPort = /** @type {import("node:net").AddressInfo} */ (upstream.address()).port;

    lavish = await serve({ port: 0, stateFile: stateFilePath });
    const lavishBase = `http://127.0.0.1:${lavish.port}`;

    const healthRes = await fetch(`${lavishBase}/health`, {
      headers: { Origin: "https://attacker.example" },
    });
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get("access-control-allow-origin"), null);

    const openRes = await fetch(`${lavishBase}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: `http://127.0.0.1:${upstreamPort}/` }),
    });
    const { key } = await openRes.json();

    await fetch(`${lavishBase}/session/${key}`);
    const fav1 = await fetch(`${lavishBase}/artifact/${key}/wrapped-favicon.svg`);
    const svg1 = await fav1.text();
    assert.equal(foreignRequests, 0, "cross-origin favicon must never be fetched");
    assert.doesNotMatch(svg1, /data:image\//);

    iconMode = "oversized";
    await fetch(`${lavishBase}/session/${key}`);
    const fav2 = await fetch(`${lavishBase}/artifact/${key}/wrapped-favicon.svg`);
    const svg2 = await fav2.text();
    assert.doesNotMatch(svg2, /data:image\//, "oversized favicon (>256 KiB) must be dropped");

    iconMode = "html";
    await fetch(`${lavishBase}/session/${key}`);
    const fav3 = await fetch(`${lavishBase}/artifact/${key}/wrapped-favicon.svg`);
    const svg3 = await fav3.text();
    assert.doesNotMatch(svg3, /data:/, "non-image MIME response must not be embedded");

    iconMode = "small";
    await fetch(`${lavishBase}/session/${key}`);
    const fav4 = await fetch(`${lavishBase}/artifact/${key}/wrapped-favicon.svg`);
    const svg4 = await fav4.text();
    assert.match(svg4, /data:image\/png;base64,/, "small same-origin image favicon must be embedded");
  } finally {
    if (lavish) await lavish.close();
    if (upstreamServer) await new Promise((resolve) => upstreamServer.close(resolve));
    if (foreignServer) await new Promise((resolve) => foreignServer.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});
