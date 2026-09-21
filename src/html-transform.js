/**
 * @param {{ initialAnnotate?: boolean }} [options]
 */
export function injectLavishSdk(html, key, artifactRevision, artifactLoadToken = "", options = {}) {
  const { initialAnnotate = false } = options;
  const revisionNumber = Number(artifactRevision);
  const revision = Number.isFinite(revisionNumber) && revisionNumber >= 0 ? Math.trunc(revisionNumber) : null;
  const revisionQuery = revision === null ? "" : `&artifact_revision=${revision}`;
  const token = String(artifactLoadToken || "").slice(0, 200);
  const tokenQuery = token ? `&artifact_load_token=${encodeURIComponent(token)}` : "";
  const annotateQuery = initialAnnotate ? "&annotate=on" : "";
  const script = `<script src="/sdk.js?key=${encodeURIComponent(key)}${revisionQuery}${tokenQuery}${annotateQuery}"></script>`;
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${script}</body>`);
  }
  return `${html}\n${script}`;
}

export function rewriteHtmlAttributes(html, prefix) {
  if (typeof html !== "string") return "";
  return html.replace(/\b(href|src|action)=(["'])([^"']*)\2/gi, (match, attr, quote, val) => {
    if (val.startsWith("/") && !val.startsWith("//") && !val.startsWith("/artifact/") && !val.startsWith("/sdk.js")) {
      return `${attr}=${quote}${prefix}${val}${quote}`;
    }
    return match;
  });
}

export function transformProxyHtml(html, key, targetUrl, artifactRevision, artifactLoadToken = "", options = {}) {
  const prefix = `/artifact/${encodeURIComponent(key)}/proxy`;
  let transformed = rewriteHtmlAttributes(html, prefix);

  const proxyBootstrapScript = `<script>
(function() {
  try {
    window.localStorage.getItem("__lavish_test__");
  } catch(e) {
    var createMemStore = function() {
      var store = {};
      return {
        getItem: function(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
        setItem: function(k, v) { store[k] = String(v); },
        removeItem: function(k) { delete store[k]; },
        clear: function() { store = {}; },
        key: function(i) { return Object.keys(store)[i] || null; },
        get length() { return Object.keys(store).length; }
      };
    };
    try {
      Object.defineProperty(window, 'localStorage', { value: createMemStore(), configurable: true });
      Object.defineProperty(window, 'sessionStorage', { value: createMemStore(), configurable: true });
    } catch(err) {}
  }
  var prefix = ${JSON.stringify(prefix)};
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function(input, init) {
      if (typeof input === "string") {
        if (input.startsWith("/") && !input.startsWith("//") && !input.startsWith("/artifact/") && !input.startsWith("/sdk.js")) {
          input = prefix + input;
        }
      } else if (input && typeof input === "object" && input.url) {
        try {
          var u = new URL(input.url, window.location.href);
          if (u.origin === window.location.origin && !u.pathname.startsWith("/artifact/") && !u.pathname.startsWith("/sdk.js")) {
            input = new Request(prefix + u.pathname + u.search, input);
          }
        } catch(e) {}
      }
      return origFetch.call(this, input, init);
    };
  }
  var origOpen = XMLHttpRequest.prototype.open;
  if (origOpen) {
    XMLHttpRequest.prototype.open = function(method, url) {
      if (typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/artifact/") && !url.startsWith("/sdk.js")) {
        url = prefix + url;
      }
      var args = Array.prototype.slice.call(arguments);
      args[1] = url;
      return origOpen.apply(this, args);
    };
  }
  var origPushState = history.pushState;
  if (origPushState) {
    history.pushState = function(state, title, url) {
      if (typeof url === "string" && url.startsWith("/") && !url.startsWith("/artifact/")) {
        url = prefix + url;
      }
      return origPushState.call(this, state, title, url);
    };
  }
  var origReplaceState = history.replaceState;
  if (origReplaceState) {
    history.replaceState = function(state, title, url) {
      if (typeof url === "string" && url.startsWith("/") && !url.startsWith("/artifact/")) {
        url = prefix + url;
      }
      return origReplaceState.call(this, state, title, url);
    };
  }
})();
</script>`;

  let pagePath = "/";
  try {
    const parsed = new URL(targetUrl);
    pagePath = parsed.pathname || "/";
  } catch {
    // Ignore invalid target URL and fall back to root
  }
  const baseTag = `<base href="${prefix}${pagePath}">`;
  if (/<head\b[^>]*>/i.test(transformed)) {
    transformed = transformed.replace(/<head\b[^>]*>/i, (m) => `${m}\n${baseTag}\n${proxyBootstrapScript}`);
  } else {
    transformed = `${baseTag}\n${proxyBootstrapScript}\n${transformed}`;
  }

  return injectLavishSdk(transformed, key, artifactRevision, artifactLoadToken, options);
}
