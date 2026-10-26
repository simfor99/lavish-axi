import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalFile, sessionKey } from "../src/session-store.js";

const exec = promisify(execFile);
const bin = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));

test("source-id shares session identity for URLs and symlinks without starting runtime state", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-source-id-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "review.html");
  const alias = path.join(dir, "alias.html");
  await writeFile(file, "<html></html>");
  await symlink(file, alias);
  const state = path.join(dir, "state");
  const env = { ...process.env, LAVISH_AXI_STATE_DIR: state, LAVISH_AXI_TELEMETRY: "0" };
  for (const source of [file, alias, "http://LOCALHOST:80/app#section", "http://localhost:3003/app?a=1"]) {
    const result = await exec(process.execPath, [bin, "source-id", source, "--json"], { env });
    const canonical = await canonicalFile(source);
    assert.deepEqual(JSON.parse(result.stdout), { source: canonical, sessionKey: sessionKey(canonical) });
  }
  assert.equal(existsSync(state), false);
  await assert.rejects(exec(process.execPath, [bin, "source-id"], { env }));
  await assert.rejects(exec(process.execPath, [bin, "source-id", file, "extra"], { env }));
});
