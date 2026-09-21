import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import os from "node:os";

export const MAX_ARTIFACT_HISTORY = 40;
const INDEX_NAME = "index.json";

function resolveStateDir(env = process.env) {
  return env.LAVISH_AXI_STATE_DIR || path.join(os.homedir(), ".lavish-axi");
}

export function historyDir(sessionKey, env = process.env) {
  return path.join(resolveStateDir(env), "revisions", String(sessionKey || ""));
}

function indexPath(sessionKey, env) {
  return path.join(historyDir(sessionKey, env), INDEX_NAME);
}

function snapshotPath(sessionKey, version, env) {
  return path.join(historyDir(sessionKey, env), `${Number(version)}.html`);
}

function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function emptyIndex() {
  return { versions: [] };
}

async function readIndex(sessionKey, env) {
  try {
    const raw = await readFile(indexPath(sessionKey, env), "utf8");
    const parsed = JSON.parse(raw);
    const versions = Array.isArray(parsed?.versions) ? parsed.versions : [];
    return {
      versions: versions
        .filter((entry) => Number.isInteger(entry?.version) && entry.version > 0 && entry.sha256)
        .sort((a, b) => a.version - b.version),
    };
  } catch {
    return emptyIndex();
  }
}

async function writeIndex(sessionKey, index, env) {
  const dir = historyDir(sessionKey, env);
  await mkdir(dir, { recursive: true });
  await writeFile(indexPath(sessionKey, env), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

export async function listArtifactHistory(sessionKey, { liveHtml, env = process.env } = {}) {
  const index = await readIndex(sessionKey, env);
  const liveHash = liveHtml == null ? null : sha256(liveHtml);
  return index.versions.map((entry) => ({
    version: entry.version,
    created_at: entry.created_at,
    sha256: entry.sha256,
    bytes: entry.bytes,
    current: liveHash ? entry.sha256 === liveHash : false,
  }));
}

export async function readArtifactHistory(sessionKey, version, env = process.env) {
  const n = Number(version);
  if (!Number.isInteger(n) || n < 1) return null;
  const index = await readIndex(sessionKey, env);
  const meta = index.versions.find((entry) => entry.version === n);
  if (!meta) return null;
  try {
    const html = await readFile(snapshotPath(sessionKey, n, env), "utf8");
    return { ...meta, html };
  } catch {
    return null;
  }
}

export async function recordArtifactSnapshot(sessionKey, html, env = process.env) {
  const body = String(html ?? "");
  const hash = sha256(body);
  const index = await readIndex(sessionKey, env);
  const last = index.versions[index.versions.length - 1];
  if (last?.sha256 === hash) {
    return { unchanged: true, version: last.version, sha256: hash };
  }
  const version = (last?.version || 0) + 1;
  const created_at = new Date().toISOString();
  const bytes = Buffer.byteLength(body, "utf8");
  const dir = historyDir(sessionKey, env);
  await mkdir(dir, { recursive: true });
  await writeFile(snapshotPath(sessionKey, version, env), body, "utf8");
  index.versions.push({ version, created_at, sha256: hash, bytes });
  while (index.versions.length > MAX_ARTIFACT_HISTORY) {
    const dropped = index.versions.shift();
    if (dropped) {
      await rm(snapshotPath(sessionKey, dropped.version, env), { force: true });
    }
  }
  await writeIndex(sessionKey, index, env);
  return { unchanged: false, version, sha256: hash, created_at, bytes };
}
