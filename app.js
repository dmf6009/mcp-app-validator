const input = document.querySelector("#manifest-input");
const output = document.querySelector("#results");

const validSample = {
  tools: [{
    name: "show_weather",
    description: "Show an interactive weather dashboard.",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    _meta: { ui: { resourceUri: "ui://weather/dashboard", visibility: ["model", "app"] } }
  }],
  resources: [{
    uri: "ui://weather/dashboard",
    name: "Weather Dashboard",
    description: "Interactive forecast view",
    mimeType: "text/html;profile=mcp-app",
    _meta: { ui: { csp: { connectDomains: ["https://api.weather.example"] }, prefersBorder: true } }
  }],
  contents: [{
    uri: "ui://weather/dashboard",
    mimeType: "text/html;profile=mcp-app",
    text: "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><main id=\"app\">Weather</main></body></html>",
    _meta: { ui: { csp: { connectDomains: ["https://api.weather.example"] }, prefersBorder: true } }
  }]
};

const invalidSample = {
  tools: [{
    name: "weather",
    inputSchema: { type: "object" },
    _meta: { "ui/resourceUri": "ui://weather/missing", ui: { visibility: ["model", "admin"] } }
  }],
  resources: [{
    uri: "https://example.com/widget",
    name: "Widget",
    mimeType: "text/html",
    _meta: { ui: { csp: { connectDomains: ["https://api.example.com/v1"], resourceDomains: ["*"] }, permissions: { camera: true }, prefersBorder: "yes" } }
  }],
  contents: [{
    uri: "https://example.com/widget",
    mimeType: "text/html",
    text: "<div>fragment only</div>",
    blob: "PGh0bWw+PC9odG1sPg=="
  }]
};

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function parseInput(raw) {
  if (!raw.trim()) throw new Error("Paste an MCP Apps snapshot containing tools, resources, or contents.");
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The snapshot must be a JSON object.");
  return value;
}

function validateOrigin(value) {
  if (typeof value !== "string" || !value) return false;
  if (value === "*") return false;
  const wildcard = value.match(/^(https|wss):\/\/\*\.([A-Za-z0-9.-]+)(?::\d+)?$/);
  if (wildcard) return !wildcard[2].includes("..");
  try {
    const url = new URL(value);
    return ["https:", "wss:"].includes(url.protocol) && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}

function validateMeta(meta, path, index, add) {
  if (meta === undefined) return;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return add("error", "UI_META_OBJECT", "_meta.ui must be an object.", index, path);
  const allowed = new Set(["csp", "permissions", "domain", "prefersBorder", "resourceUri", "visibility"]);
  Object.keys(meta).filter(k => !allowed.has(k)).forEach(k => add("warning", "UNKNOWN_UI_META", `Unknown UI metadata field "${k}".`, index, `${path}/${k}`));
  if ("prefersBorder" in meta && typeof meta.prefersBorder !== "boolean") add("error", "BORDER_BOOLEAN", "prefersBorder must be boolean.", index, `${path}/prefersBorder`);
  if ("domain" in meta && (typeof meta.domain !== "string" || !meta.domain.trim())) add("error", "DOMAIN_STRING", "domain must be a non-empty host-specific string.", index, `${path}/domain`);
  if (meta.csp !== undefined) {
    if (!meta.csp || typeof meta.csp !== "object" || Array.isArray(meta.csp)) add("error", "CSP_OBJECT", "csp must be an object.", index, `${path}/csp`);
    else {
      const keys = ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"];
      Object.keys(meta.csp).filter(k => !keys.includes(k)).forEach(k => add("error", "CSP_FIELD", `Unknown CSP field "${k}".`, index, `${path}/csp/${k}`));
      keys.forEach(key => {
        if (!(key in meta.csp)) return;
        if (!Array.isArray(meta.csp[key])) return add("error", "CSP_ARRAY", `${key} must be an array.`, index, `${path}/csp/${key}`);
        const seen = new Set();
        meta.csp[key].forEach((origin, i) => {
          if (!validateOrigin(origin)) add("error", "CSP_ORIGIN", `"${origin}" must be an exact HTTPS/WSS origin or HTTPS/WSS wildcard subdomain, without a path.`, index, `${path}/csp/${key}/${i}`);
          if (seen.has(origin)) add("warning", "CSP_DUPLICATE", `Duplicate CSP origin "${origin}".`, index, `${path}/csp/${key}/${i}`);
          seen.add(origin);
        });
      });
    }
  }
  if (meta.permissions !== undefined) {
    const keys = ["camera", "microphone", "geolocation", "clipboardWrite"];
    if (!meta.permissions || typeof meta.permissions !== "object" || Array.isArray(meta.permissions)) add("error", "PERMISSIONS_OBJECT", "permissions must be an object.", index, `${path}/permissions`);
    else Object.entries(meta.permissions).forEach(([key, value]) => {
      if (!keys.includes(key)) add("error", "UNKNOWN_PERMISSION", `"${key}" is not a stable MCP Apps permission.`, index, `${path}/permissions/${key}`);
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) add("error", "PERMISSION_SHAPE", `${key} must be an empty object {}.`, index, `${path}/permissions/${key}`);
    });
  }
}

function validateSnapshot(snapshot) {
  const issues = [], resourceMap = new Map(), contentMap = new Map(), links = [];
  const add = (severity, code, message, index, path) => issues.push({ severity, code, message, index, path });
  const arrays = ["tools", "resources", "contents"];
  arrays.forEach(key => { if (key in snapshot && !Array.isArray(snapshot[key])) add("error", "TOP_LEVEL_ARRAY", `${key} must be an array.`, 0, `/${key}`); });
  if (!arrays.some(key => Array.isArray(snapshot[key]))) add("error", "EMPTY_SNAPSHOT", "Provide at least one tools, resources, or contents array.", 0, "/");

  (Array.isArray(snapshot.resources) ? snapshot.resources : []).forEach((resource, index) => {
    const path = `/resources/${index}`;
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) return add("error", "RESOURCE_OBJECT", "Every resource must be an object.", index, path);
    if (typeof resource.uri !== "string" || !resource.uri.startsWith("ui://")) add("error", "UI_URI", 'UI resource uri must start with "ui://".', index, `${path}/uri`);
    if (typeof resource.name !== "string" || !resource.name.trim()) add("error", "RESOURCE_NAME", "Resource name must be a non-empty string.", index, `${path}/name`);
    if (resource.mimeType !== "text/html;profile=mcp-app") add("error", "MIME_TYPE", 'MCP App HTML must use "text/html;profile=mcp-app".', index, `${path}/mimeType`);
    if (resourceMap.has(resource.uri)) add("error", "DUPLICATE_RESOURCE", `Duplicate resource URI "${resource.uri}".`, index, `${path}/uri`);
    else if (typeof resource.uri === "string") resourceMap.set(resource.uri, resource);
    validateMeta(resource._meta?.ui, `${path}/_meta/ui`, index, add);
  });

  (Array.isArray(snapshot.contents) ? snapshot.contents : []).forEach((content, index) => {
    const path = `/contents/${index}`;
    if (!content || typeof content !== "object" || Array.isArray(content)) return add("error", "CONTENT_OBJECT", "Every content item must be an object.", index, path);
    if (typeof content.uri !== "string" || !content.uri.startsWith("ui://")) add("error", "UI_URI", 'Content uri must start with "ui://".', index, `${path}/uri`);
    if (content.mimeType !== "text/html;profile=mcp-app") add("error", "MIME_TYPE", 'Content MIME type must be "text/html;profile=mcp-app".', index, `${path}/mimeType`);
    const forms = ["text", "blob"].filter(k => Object.hasOwn(content, k));
    if (forms.length !== 1) add("error", "CONTENT_PAYLOAD", "Provide exactly one of text or blob.", index, path);
    if ("text" in content && typeof content.text !== "string") add("error", "TEXT_STRING", "text must be a string.", index, `${path}/text`);
    if ("blob" in content && (typeof content.blob !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(content.blob))) add("error", "BLOB_BASE64", "blob must be base64-encoded HTML.", index, `${path}/blob`);
    if (typeof content.text === "string" && (!/<!doctype html/i.test(content.text) || !/<html[\s>]/i.test(content.text))) add("warning", "HTML_DOCUMENT", "HTML content should be a complete HTML5 document with doctype and html element.", index, `${path}/text`);
    if (contentMap.has(content.uri)) add("error", "DUPLICATE_CONTENT", `Duplicate content URI "${content.uri}".`, index, `${path}/uri`);
    else if (typeof content.uri === "string") contentMap.set(content.uri, content);
    validateMeta(content._meta?.ui, `${path}/_meta/ui`, index, add);
  });

  (Array.isArray(snapshot.tools) ? snapshot.tools : []).forEach((tool, index) => {
    const path = `/tools/${index}`;
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return add("error", "TOOL_OBJECT", "Every tool must be an object.", index, path);
    if (typeof tool.name !== "string" || !tool.name.trim()) add("error", "TOOL_NAME", "Tool name must be a non-empty string.", index, `${path}/name`);
    if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) add("error", "INPUT_SCHEMA", "inputSchema must be an object.", index, `${path}/inputSchema`);
    const modern = tool._meta?.ui?.resourceUri;
    const legacy = tool._meta?.["ui/resourceUri"];
    if (legacy !== undefined) add("warning", "LEGACY_RESOURCE_URI", 'Flat _meta["ui/resourceUri"] is deprecated; use _meta.ui.resourceUri.', index, `${path}/_meta/ui~1resourceUri`);
    if (modern !== undefined && (typeof modern !== "string" || !modern.startsWith("ui://"))) add("error", "TOOL_UI_URI", 'resourceUri must start with "ui://".', index, `${path}/_meta/ui/resourceUri`);
    if (modern && legacy && modern !== legacy) add("error", "RESOURCE_URI_CONFLICT", "Modern and legacy resource URIs disagree.", index, `${path}/_meta`);
    const uri = modern || legacy;
    if (uri) links.push({ uri, tool: tool.name, index, path });
    const visibility = tool._meta?.ui?.visibility;
    if (visibility !== undefined) {
      if (!Array.isArray(visibility) || !visibility.length) add("error", "VISIBILITY_ARRAY", "visibility must be a non-empty array.", index, `${path}/_meta/ui/visibility`);
      else {
        const seen = new Set();
        visibility.forEach((value, i) => {
          if (!["model", "app"].includes(value)) add("error", "VISIBILITY_VALUE", `"${value}" must be "model" or "app".`, index, `${path}/_meta/ui/visibility/${i}`);
          if (seen.has(value)) add("warning", "VISIBILITY_DUPLICATE", `Duplicate visibility "${value}".`, index, `${path}/_meta/ui/visibility/${i}`);
          seen.add(value);
        });
      }
    }
  });

  links.forEach(link => {
    if (!resourceMap.has(link.uri) && !contentMap.has(link.uri)) add("error", "MISSING_UI_RESOURCE", `Tool "${link.tool}" references "${link.uri}", but that resource was not supplied.`, link.index, `${link.path}/_meta/ui/resourceUri`);
  });
  resourceMap.forEach((resource, uri) => {
    if (snapshot.contents && !contentMap.has(uri)) add("warning", "MISSING_CONTENT", `Declared resource "${uri}" has no matching content item.`, 0, `/resources`);
  });
  contentMap.forEach((content, uri) => {
    if (snapshot.resources && !resourceMap.has(uri)) add("warning", "UNDECLARED_CONTENT", `Content "${uri}" has no matching resource declaration.`, 0, `/contents`);
  });
  return { issues, counts: { tools: snapshot.tools?.length || 0, resources: resourceMap.size, contents: contentMap.size, links: links.length } };
}

function render(result) {
  const errors = result.issues.filter(i => i.severity === "error"), warnings = result.issues.filter(i => i.severity === "warning");
  const issues = result.issues.length ? result.issues.map(i => `<article class="issue ${i.severity}"><div class="issue-code">${escapeHtml(i.severity.toUpperCase())} · ${escapeHtml(i.code)}</div><p>${escapeHtml(i.message)}</p><div class="path">${escapeHtml(i.path)}</div></article>`).join("") : '<article class="issue success"><div class="issue-code">READY FOR HOST TESTING</div><p>No structural, linkage, CSP or metadata problems were found.</p></article>';
  output.innerHTML = `<div class="summary"><div class="metric"><b>${result.counts.tools}</b>tools</div><div class="metric"><b>${errors.length}</b>errors</div><div class="metric"><b>${warnings.length}</b>warnings</div></div>${issues}<div class="tree"><h3>Snapshot coverage</h3><code>${result.counts.resources} resource declaration(s)\n${result.counts.contents} content item(s)\n${result.counts.links} tool-to-UI link(s)</code></div>`;
}

function run() {
  try { render(validateSnapshot(parseInput(input.value))); }
  catch (error) { output.innerHTML = `<article class="issue"><div class="issue-code">PARSE ERROR</div><p>${escapeHtml(error.message)}</p></article>`; }
}

document.querySelector("#validate")?.addEventListener("click", run);
document.querySelector("#sample")?.addEventListener("click", () => { input.value = JSON.stringify(validSample, null, 2); run(); });
document.querySelector("#broken")?.addEventListener("click", () => { input.value = JSON.stringify(invalidSample, null, 2); run(); });
document.querySelector("#clear")?.addEventListener("click", () => { input.value = ""; output.innerHTML = '<div class="empty"><b>{ }</b>Paste a snapshot and run the validator.</div>'; input.focus(); });
if (input) { input.value = JSON.stringify(validSample, null, 2); run(); }
