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
