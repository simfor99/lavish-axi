import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { serve } from "../src/server.js";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

test("wrapped local favicons keep allowed icons and refuse paths outside the artifact directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-favicon-boundary-"));
  const root = path.join(dir, "artifacts");
  const outside = path.join(dir, "outside.txt");
  const sentinel = "FIXTURE_OUTSIDE_ARTIFACT";
  await mkdir(root);
  await writeFile(outside, sentinel);
  await symlink(outside, path.join(root, "escape.svg"));
  const icon = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
  await writeFile(path.join(root, "icon.svg"), icon);
  await symlink("icon.svg", path.join(root, "alias.svg"));
  const encodedIcon = Buffer.from(icon).toString("base64");
  const cases = [
    { href: "../outside.txt", allowed: false },
    { href: outside, allowed: false },
    { href: "escape.svg", allowed: false },
    { href: "icon.svg", allowed: true },
    { href: "alias.svg", allowed: true },
    { href: `data:image/svg+xml;base64,${encodedIcon}`, allowed: true },
  ];
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    for (const [index, { href, allowed }] of cases.entries()) {
      const file = path.join(root, `artifact-${index}.html`);
      await writeFile(file, `<html><head><link rel="icon" href="${href}"></head><body>test</body></html>`);
      const response = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file }),
      });
      assert.equal(response.status, 200);
      const { key } = await response.json();
      const favicon = await fetch(`${base}/artifact/${key}/wrapped-favicon.svg`);
      assert.equal(favicon.status, 200);
      const body = await favicon.text();
      assert.equal(body.includes(Buffer.from(sentinel).toString("base64")), false, href);
      assert.equal(body.includes(encodedIcon), allowed, href);
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
