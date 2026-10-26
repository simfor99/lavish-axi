import assert from "node:assert/strict";
import test from "node:test";

import {
  bindHost,
  clientHost,
  extraAllowedHosts,
  hostForUrl,
  isLoopbackHost,
  LOOPBACK_HOST,
  linkHost,
  resolveLinkHost,
} from "../src/paths.js";

test("isLoopbackHost identifies loopback addresses and rejects remote/network hosts", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("sub.localhost"), true);
  assert.equal(isLoopbackHost("127.0.1.1"), true);
  assert.equal(isLoopbackHost("ryzen.tail0df162.ts.net"), false);
  assert.equal(isLoopbackHost("100.64.0.1"), false);
  assert.equal(isLoopbackHost("192.168.1.1"), false);
  assert.equal(isLoopbackHost("example.com"), false);
  assert.equal(isLoopbackHost(""), false);
  assert.equal(isLoopbackHost(null), false);
});

test("resolveLinkHost prioritizes explicit LAVISH_AXI_LINK_HOST before Tailscale MagicDNS", () => {
  assert.equal(resolveLinkHost({}), LOOPBACK_HOST);
  assert.equal(
    resolveLinkHost({
      env: { LAVISH_AXI_LINK_HOST: "custom.example" },
      tailscale: { magicDnsName: "ryzen.tail0df162.ts.net" },
    }),
    "custom.example",
  );
  assert.equal(
    resolveLinkHost({
      env: { LAVISH_AXI_LINK_HOST: "127.0.0.1" },
      tailscale: { magicDnsName: "ryzen.tail0df162.ts.net" },
    }),
    "127.0.0.1",
  );
  assert.equal(
    resolveLinkHost({
      env: {},
      tailscale: { magicDnsName: "ryzen.tail0df162.ts.net" },
    }),
    "ryzen.tail0df162.ts.net",
  );
  assert.equal(
    resolveLinkHost({
      env: {},
      fallbackHost: "192.168.1.5",
    }),
    "192.168.1.5",
  );
  assert.equal(
    resolveLinkHost({
      env: {},
      fallbackHost: "0.0.0.0",
    }),
    LOOPBACK_HOST,
  );
});

test("bindHost defaults to loopback and honors LAVISH_AXI_HOST", () => {
  assert.equal(bindHost({}), LOOPBACK_HOST);
  assert.equal(bindHost({ LAVISH_AXI_HOST: "" }), LOOPBACK_HOST);
  assert.equal(bindHost({ LAVISH_AXI_HOST: "  " }), LOOPBACK_HOST);
  assert.equal(bindHost({ LAVISH_AXI_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(bindHost({ LAVISH_AXI_HOST: " 0.0.0.0 " }), "0.0.0.0");
});

test("clientHost dials the concrete primary listener for wildcard binds", () => {
  assert.equal(clientHost({}), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(clientHost({ LAVISH_AXI_HOST: "0.0.0.0" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "::" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "[::]" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "0:0:0:0:0:0:0:0" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "[0:0:0:0:0:0:0:0]" }), LOOPBACK_HOST);
  assert.equal(clientHost({ LAVISH_AXI_HOST: "::ffff:0.0.0.0" }), LOOPBACK_HOST);
});

test("extraAllowedHosts parses the whitespace-separated opt-in list", () => {
  assert.deepEqual(extraAllowedHosts({}), []);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "" }), []);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "  " }), []);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "proxy.example" }), ["proxy.example"]);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "  a.example   b.example\tc.example  " }), [
    "a.example",
    "b.example",
    "c.example",
  ]);
  assert.deepEqual(extraAllowedHosts({ LAVISH_AXI_ALLOWED_HOSTS: "*" }), ["*"]);
});

test("linkHost prefers LAVISH_AXI_LINK_HOST, then falls back to the dial host", () => {
  assert.equal(linkHost({}), LOOPBACK_HOST);
  assert.equal(linkHost({ LAVISH_AXI_LINK_HOST: "host.example" }), "host.example");
  assert.equal(linkHost({ LAVISH_AXI_LINK_HOST: "  " }), LOOPBACK_HOST);
  // Non-wildcard bind with no explicit link host -> links reuse the bind address.
  assert.equal(linkHost({ LAVISH_AXI_HOST: "100.64.0.1" }), "100.64.0.1");
  // Wildcard bind with an explicit link host -> links use the hostname, not 0.0.0.0.
  assert.equal(linkHost({ LAVISH_AXI_HOST: "0.0.0.0", LAVISH_AXI_LINK_HOST: "host.example" }), "host.example");
  // IPv6 wildcard bind with no explicit link host -> links use the concrete loopback listener.
  assert.equal(linkHost({ LAVISH_AXI_HOST: "::" }), LOOPBACK_HOST);
});

test("hostForUrl brackets IPv6 literals but leaves IPv4 and hostnames alone", () => {
  assert.equal(hostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(hostForUrl("host.example"), "host.example");
  assert.equal(hostForUrl("::1"), "[::1]");
  assert.equal(hostForUrl("[::1]"), "[::1]");
});
