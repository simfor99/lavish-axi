import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/chrome-client.js", import.meta.url), "utf8");
const copySource = source.slice(
  source.indexOf("async function copyText(text)"),
  source.indexOf("// One transcript entry"),
);
const bridgeSource = source.slice(
  source.indexOf("async function handleFrameCopyUrl(msg)"),
  source.indexOf("let lastFaviconSource"),
);

test("clipboard fallback reports denial and always restores focus and removes its helper", async () => {
  for (const throws of [false, true]) {
    let removed = 0;
    let focused = 0;
    const helper = {
      style: {},
      focus() {},
      select() {},
      remove() {
        removed++;
      },
    };
    const context = vm.createContext({
      navigator: {
        clipboard: {
          writeText: async () => {
            throw new Error("denied");
          },
        },
      },
      document: {
        activeElement: {
          focus() {
            focused++;
          },
        },
        body: { appendChild() {} },
        createElement: () => helper,
        execCommand() {
          if (throws) throw new Error("denied");
          return false;
        },
      },
    });
    vm.runInContext(copySource, context);
    assert.equal(await vm.runInContext('copyText("session URL")', context), false);
    assert.equal(removed, 1);
    assert.equal(focused, 1);
  }
});

test("session copy bridge rejects arbitrary URL, wrong session, stale load and missing activation", async () => {
  let copies = 0;
  const messages = [];
  const currentFrame = { postMessage: (msg) => messages.push(msg) };
  const context = vm.createContext({
    navigator: { userActivation: { isActive: true } },
    frame: { contentWindow: currentFrame },
    copyText: async () => {
      copies++;
      return true;
    },
  });
  vm.runInContext(
    'let artifactLoadToken="current";const localAccessUrl="http://localhost:4387/session/abc?annotate=off";const remoteAccessUrl="http://100.64.0.1:4387/session/abc?annotate=off";',
    context,
  );
  vm.runInContext(bridgeSource, context);
  for (const url of ["https://example.com/", "http://localhost:4387/session/other?annotate=off", "/tmp/source.md"]) {
    context.msg = { url, requestId: 1, artifact_load_token: "current" };
    await vm.runInContext("handleFrameCopyUrl(msg)", context);
  }
  context.msg = { url: "http://localhost:4387/session/abc?annotate=off", requestId: 1, artifact_load_token: "stale" };
  await vm.runInContext("handleFrameCopyUrl(msg)", context);
  context.msg.artifact_load_token = "current";
  context.navigator.userActivation.isActive = false;
  await vm.runInContext("handleFrameCopyUrl(msg)", context);
  assert.equal(copies, 0);
  assert.ok(messages.every((msg) => msg.success === false));
  context.navigator.userActivation.isActive = true;
  await vm.runInContext("handleFrameCopyUrl(msg)", context);
  assert.equal(copies, 1);
  assert.equal(messages.at(-1).success, true);
});

test("a copy completing after load replacement cannot reply into the new load", async () => {
  /** @type {(value: boolean) => void} */
  let complete = () => {
    throw new Error("Copy did not start");
  };
  let replies = 0;
  const context = vm.createContext({
    navigator: { userActivation: { isActive: true } },
    frame: {
      contentWindow: {
        postMessage() {
          replies++;
        },
      },
    },
    copyText: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  vm.runInContext(
    'let artifactLoadToken="current";const localAccessUrl="http://localhost:4387/session/abc?annotate=off";const remoteAccessUrl="";',
    context,
  );
  vm.runInContext(bridgeSource, context);
  const pending = vm.runInContext(
    'handleFrameCopyUrl({url:localAccessUrl,requestId:1,artifact_load_token:"current"})',
    context,
  );
  vm.runInContext('artifactLoadToken="replacement"', context);
  complete(true);
  await pending;
  assert.equal(replies, 0);
});
