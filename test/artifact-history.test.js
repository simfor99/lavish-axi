import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listArtifactHistory,
  MAX_ARTIFACT_HISTORY,
  readArtifactHistory,
  recordArtifactSnapshot,
} from "../src/artifact-history.js";

async function withStateDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-history-"));
  try {
    return await run({ LAVISH_AXI_STATE_DIR: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("recordArtifactSnapshot stores a new version only when content changes", async () => {
  await withStateDir(async (env) => {
    const first = await recordArtifactSnapshot("abc", "<p>one</p>", env);
    assert.equal(first.unchanged, false);
    assert.equal(first.version, 1);
    const same = await recordArtifactSnapshot("abc", "<p>one</p>", env);
    assert.equal(same.unchanged, true);
    assert.equal(same.version, 1);
    const second = await recordArtifactSnapshot("abc", "<p>two</p>", env);
    assert.equal(second.unchanged, false);
    assert.equal(second.version, 2);
    const listed = await listArtifactHistory("abc", { liveHtml: "<p>two</p>", env });
    assert.equal(listed.length, 2);
    assert.equal(listed[0].current, false);
    assert.equal(listed[1].current, true);
    const snap = await readArtifactHistory("abc", 1, env);
    assert.equal(snap.html, "<p>one</p>");
  });
});

test("recordArtifactSnapshot drops the oldest snapshot past the cap", async () => {
  await withStateDir(async (env) => {
    for (let i = 0; i < MAX_ARTIFACT_HISTORY + 3; i += 1) {
      await recordArtifactSnapshot("cap", `<p>${i}</p>`, env);
    }
    const listed = await listArtifactHistory("cap", { env });
    assert.equal(listed.length, MAX_ARTIFACT_HISTORY);
    assert.equal(listed[0].version, 4);
    assert.equal(listed[listed.length - 1].version, MAX_ARTIFACT_HISTORY + 3);
    assert.equal(await readArtifactHistory("cap", 1, env), null);
  });
});
