// Turn one observed call into things an implementation engineer can use directly:
// a curl command, a typed fetch function, an OpenAPI document, and a "verify" snippet that
// someone inside the customer network pastes into the browser console to prove the call works.
//
// Every dynamic value becomes a named variable with a stated origin. Concrete secrets never
// appear, because the scrubber already replaced them with placeholders.

import { hasToken, safeDecode, safeUrl } from "./har.ts";
import { camel, templatePath } from "./normalize.ts";
import type { ParsedBody } from "./normalize.ts";
import { summarizeShape, toJsonSchema } from "./shape.ts";
import type { Artifacts, Binding, Call, Endpoint, Loc, Report, Source } from "./types.ts";

const L = "\u27e6";
const R = "\u27e7";
const MARK = /\u27e6(#?)([A-Za-z0-9_$]+)\u27e7/g;
const TOKEN = /\{\{(secret|input):([^}]+)\}\}/g;
const WHOLE_TOKEN = /^\{\{(secret|input):[^}]+\}\}$/;

export function shortId(call: Pick<Call, "method" | "pathTemplate" | "operation">): string {
  return `${call.method} ${call.pathTemplate}${call.operation ? ` [${call.operation}]` : ""}`;
}

export function describeSource(source: Source, calls: Call[]): string {
  switch (source.kind) {
    case "input":
      return `typed by the recorder ("${source.label.replace(/_/g, " ")}")`;
    case "literal":
      return "fixed in this recording (most likely a record the user picked on screen)";
    case "secret":
      return `credential ${source.token}; its origin is not in the recording`;
    case "response": {
      const from = calls[source.callIndex] ? shortId(calls[source.callIndex]) : source.endpointId;
      const where =
        source.via === "json"
          ? source.path
          : source.via === "html-meta"
            ? `<meta name="${source.path}">`
            : source.via === "html-input"
              ? `<input name="${source.path}">`
              : source.via === "set-cookie"
                ? `Set-Cookie ${source.path}`
                : source.via === "header"
                  ? `${source.path} response header`
                  : `a URL in the page (${source.path})`;
      return `${from} → ${where}`;
    }
  }
}

interface Var {
  name: string;
  source: Source;
  example: string;
  numeric?: boolean;
}

class VarTable {
  private byKey = new Map<string, Var>();
  private names = new Map<string, Var>();

  get(key: string, wantName: string, source: Source, example: string): Var {
    const cur = this.byKey.get(key);
    if (cur) {
      if (cur.source.kind !== "response" && source.kind === "response") cur.source = source;
      return cur;
    }
    const base = camel(wantName) || "value";
    let name = base;
    for (let n = 2; this.names.has(name); n++) name = `${base}${n}`;
    const v = { name, source, example };
    this.byKey.set(key, v);
    this.names.set(name, v);
    return v;
  }

  byName(name: string): Var | undefined {
    return this.names.get(name);
  }
}

function niceName(b: Binding): string {
  if (b.in === "header") {
    if (/^authorization$/i.test(b.name)) return "authToken";
    return b.name.replace(/^x-/i, "");
  }
  if (b.in === "body" && b.name.startsWith("$")) {
    const keys = [...b.name.matchAll(/\.([A-Za-z_]\w*)|\["([^"]+)"\]/g)].map((m) => m[1] ?? m[2]);
    const last = keys[keys.length - 1] ?? "value";
    if (/^(id|value|name|code|key|uuid)$/i.test(last) && keys.length > 1) return `${keys[keys.length - 2]}_${last}`;
    return last;
  }
  return b.name;
}

interface Templated {
  call: Call;
  pathSegs: string[];
  query: [string, string][];
  headers: [string, string][];
  cookies: [string, string][];
  body: ParsedBody;
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_]\w*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function templateCall(call: Call, table: VarTable): Templated {
  const local = new Map<string, { match: string; marker: string }>();
  for (const b of call.bindings) {
    if (b.source.kind === "input") {
      table.get(b.match, b.source.label.replace(/~\d+$/, ""), b.source, b.match);
    } else if (WHOLE_TOKEN.test(b.match)) {
      table.get(b.match, niceName(b), b.source, b.match);
    } else if (!hasToken(b.match)) {
      const v = table.get(`val:${b.match}`, niceName(b), b.source, b.match);
      local.set(`${b.in}:${b.name}`, { match: b.match, marker: `${L}${v.name}${R}` });
    }
  }
  const tokens = (s: string): string =>
    s.replace(TOKEN, (tok: string, kind: string, label: string) => {
      const source: Source = kind === "input" ? { kind: "input", label } : { kind: "secret", token: tok };
      return `${L}${table.get(tok, label.replace(/~\d+$/, ""), source, tok).name}${R}`;
    });
  const sub = (s: string, loc: Loc, name: string): string => {
    const l = local.get(`${loc}:${name}`);
    if (l && s.includes(l.match)) s = s.replace(l.match, l.marker);
    return tokens(s);
  };

  const url = safeUrl(call.url);
  const rawPath = url?.pathname ?? call.path;
  const { params } = templatePath(rawPath);
  const paramAt = new Map(params.map((p) => [p.index, p.name]));
  const pathSegs = rawPath.split("/").map((seg, i) => {
    const decoded = safeDecode(seg);
    return paramAt.has(i) ? sub(decoded, "path", paramAt.get(i)!) : tokens(decoded);
  });

  const mapJson = (v: unknown, path: string): unknown => {
    if (typeof v === "string") return sub(v, "body", path);
    if (typeof v === "number") {
      const l = local.get(`body:${path}`);
      if (!l || l.match !== String(v)) return v;
      const hit = table.byName(l.marker.slice(1, -1));
      if (hit) hit.numeric = true;
      return l.marker.replace(L, `${L}#`);
    }
    if (Array.isArray(v)) return v.map((x, i) => mapJson(x, `${path}[${i}]`));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, mapJson(x, childPath(path, k))]));
    }
    return v;
  };
  let body: ParsedBody = call.body;
  if (body.kind === "json") body = { kind: "json", value: mapJson(body.value, "$") };
  else if (body.kind === "form" || body.kind === "multipart") {
    body = { kind: body.kind, fields: body.fields.map((f) => ({ name: f.name, value: sub(f.value, "body", f.name) })) };
  } else if (body.kind === "text") body = { kind: "text", text: tokens(body.text) };

  return {
    call,
    pathSegs,
    query: call.query.map((q) => [q.name, sub(q.value, "query", q.name)]),
    headers: call.headers.map((h) => [h.name, sub(h.value, "header", h.name)]),
    cookies: call.cookies.map((c) => [c.name, sub(c.value, "cookie", c.name)]),
    body,
  };
}

type Part = { lit: string } | { v: string; numeric: boolean };

function parts(s: string): Part[] {
  const out: Part[] = [];
  let last = 0;
  for (const m of s.matchAll(MARK)) {
    if (m.index! > last) out.push({ lit: s.slice(last, m.index) });
    out.push({ v: m[2], numeric: m[1] === "#" });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ lit: s.slice(last) });
  return out;
}

function markersIn(...strings: string[]): string[] {
  const out: string[] = [];
  for (const s of strings) for (const m of s.matchAll(MARK)) if (!out.includes(m[2])) out.push(m[2]);
  return out;
}

function bodyStrings(body: ParsedBody): string[] {
  if (body.kind === "json") return [JSON.stringify(body.value)];
  if (body.kind === "form" || body.kind === "multipart") return body.fields.map((f) => f.value);
  if (body.kind === "text") return [body.text];
  return [];
}

/** Variables the request needs, ignoring cookies (the browser attaches those itself). */
function usedOutsideCookies(t: Templated): string[] {
  return markersIn(...t.pathSegs, ...t.query.map((q) => q[1]), ...t.headers.map((h) => h[1]), ...bodyStrings(t.body));
}

// ---------- JavaScript / TypeScript rendering ----------

const tplLit = (s: string) => s.replace(/[`\\]/g, "\\$&").replace(/\$\{/g, "\\${");

function jsExpr(s: string, ns: string): string {
  const p = parts(s);
  if (p.every((x) => "lit" in x)) return JSON.stringify(s);
  if (p.length === 1 && "v" in p[0]) return `${ns}.${p[0].v}`;
  return "`" + p.map((x) => ("lit" in x ? tplLit(x.lit) : `\${${ns}.${x.v}}`)).join("") + "`";
}

function jsUrl(t: Templated, base: string, ns: string): string {
  const enc = (s: string) =>
    parts(s)
      .map((x) => ("lit" in x ? tplLit(encodeURIComponent(x.lit)) : `\${encodeURIComponent(${ns}.${x.v})}`))
      .join("");
  const path = t.pathSegs.map(enc).join("/");
  const query = t.query.map(([k, v]) => `${encodeURIComponent(k)}=${enc(v)}`).join("&");
  return "`" + base + path + (query ? `?${query}` : "") + "`";
}

function jsValue(v: unknown, ns: string, indent: string): string {
  if (typeof v === "string") return jsExpr(v, ns);
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const inner = indent + "  ";
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return `[\n${v.map((x) => inner + jsValue(x, ns, inner)).join(",\n")},\n${indent}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return "{}";
  return `{\n${entries
    .map(([k, x]) => `${inner}${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${jsValue(x, ns, inner)}`)
    .join(",\n")},\n${indent}}`;
}

function jsHeaders(t: Templated, ns: string, withCookies: boolean, indent: string, extra: [string, string][] = []): string {
  const h: [string, string][] = [];
  if (t.body.kind === "json") h.push(["Content-Type", JSON.stringify(t.call.requestMime || "application/json")]);
  if (t.body.kind === "form") h.push(["Content-Type", JSON.stringify("application/x-www-form-urlencoded")]);
  if (t.body.kind === "text" && t.call.requestMime) h.push(["Content-Type", JSON.stringify(t.call.requestMime)]);
  if ((t.call.responseMime ?? "").includes("json")) h.push(["Accept", JSON.stringify("application/json")]);
  for (const [k, v] of t.headers) h.push([k, jsExpr(v, ns)]);
  if (withCookies && t.cookies.length) {
    h.push(["Cookie", jsExpr(t.cookies.map(([k, v]) => `${k}=${v}`).join("; "), ns)]);
  }
  h.push(...extra);
  if (!h.length) return "{}";
  return `{\n${h.map(([k, v]) => `${indent}  ${JSON.stringify(k)}: ${v}`).join(",\n")},\n${indent}}`;
}

function jsBody(t: Templated, ns: string, indent: string): string | undefined {
  const b = t.body;
  if (b.kind === "json") return `JSON.stringify(${jsValue(b.value, ns, indent)})`;
  if (b.kind === "form") {
    return `new URLSearchParams([\n${b.fields.map((f) => `${indent}  [${JSON.stringify(f.name)}, ${jsExpr(f.value, ns)}]`).join(",\n")},\n${indent}]).toString()`;
  }
  if (b.kind === "multipart") {
    const rows = b.fields.map((f) =>
      f.value.startsWith("(file:")
        ? `${indent}  // ${JSON.stringify(f.name)}: ${f.value} - attach the file yourself`
        : `${indent}  form.append(${JSON.stringify(f.name)}, ${jsExpr(f.value, ns)});`,
    );
    return `(() => {\n${indent}  const form = new FormData();\n${rows.join("\n")}\n${indent}  return form;\n${indent}})()`;
  }
  if (b.kind === "text") return jsExpr(b.text, ns);
  return undefined;
}

function fnName(call: Call): string {
  const segs = call.pathTemplate
    .split("/")
    .filter((s) => s && !s.startsWith("{"))
    .map((s) => s.replace(/\.[a-z]{2,5}$/i, ""))
    .slice(-3);
  const op = call.operation ? call.operation.replace(/^(graphql|rpc|soap)\s+/, "").replace(/^\w+=/, "") : "";
  return camel(`${call.method.toLowerCase()} ${op || segs.join(" ") || "root"}`);
}

function varDoc(v: Var, calls: Call[]): string {
  return describeSource(v.source, calls);
}

function renderTypescript(call: Call, calls: Call[]): string {
  const table = new VarTable();
  const t = templateCall(call, table);
  const used = markersIn(
    ...t.pathSegs,
    ...t.query.map((q) => q[1]),
    ...t.headers.map((h) => h[1]),
    ...t.cookies.map((c) => c[1]),
    ...bodyStrings(t.body),
  );
  const name = fnName(call);
  const typeName = name.charAt(0).toUpperCase() + name.slice(1) + "Vars";
  const fields = used
    .map((n) => table.byName(n)!)
    .map((v) => `  /** ${varDoc(v, calls)} */\n  ${v.name}: ${v.numeric ? "number" : "string"};`)
    .join("\n");
  const body = jsBody(t, "v", "    ");
  const mutating = !["GET", "HEAD"].includes(call.method);
  const returnsJson = (call.responseMime ?? "").includes("json");
  const hdr = jsHeaders(t, "v", true, "    ", mutating ? [["Origin", "baseUrl"]] : []);
  return [
    `// ${shortId(call)}`,
    `// Observed: HTTP ${call.status}${call.responseMime ? `, ${call.responseMime}` : ""}${call.responseShape ? `\n// Response shape: ${summarizeShape(call.responseShape, 2, 10)}` : ""}`,
    used.length ? `export interface ${typeName} {\n${fields}\n}` : `export type ${typeName} = Record<string, never>;`,
    "",
    `export async function ${name}(v: ${typeName}, baseUrl = ${JSON.stringify(call.origin)}) {`,
    `  const res = await fetch(${jsUrl(t, "${baseUrl}", "v")}, {`,
    `    method: ${JSON.stringify(call.method)},`,
    `    headers: ${hdr},`,
    ...(body ? [`    body: ${body},`] : []),
    `    redirect: "manual",`,
    `  });`,
    `  if (res.status >= 400) throw new Error(\`${shortId(call).replace(/[`\\$]/g, "\\$&")} failed: \${res.status}\`);`,
    returnsJson ? `  return res.json();` : `  return res; // ${call.responseMime ?? "no body"}${call.redirect ? `; observed redirect to ${call.redirect}` : ""}`,
    `}`,
  ].join("\n");
}

// ---------- curl rendering ----------

const upper = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
const shLit = (s: string) => s.replace(/(["\\$`])/g, "\\$1");
const sh = (s: string) => parts(s).map((x) => ("lit" in x ? shLit(x.lit) : `\${${upper(x.v)}}`)).join("");

function renderCurl(call: Call, calls: Call[]): string {
  const table = new VarTable();
  const t = templateCall(call, table);
  const enc = (s: string) => parts(s).map((x) => ("lit" in x ? encodeURIComponent(x.lit) : `\${${upper(x.v)}}`)).join("");
  const url = `\${BASE_URL}${t.pathSegs.map(enc).join("/")}${t.query.length ? "?" + t.query.map(([k, v]) => `${encodeURIComponent(k)}=${enc(v)}`).join("&") : ""}`;
  const used = markersIn(
    ...t.pathSegs,
    ...t.query.map((q) => q[1]),
    ...t.headers.map((h) => h[1]),
    ...t.cookies.map((c) => c[1]),
    ...bodyStrings(t.body),
  );
  const lines: string[] = [`# ${shortId(call)}`];
  if (used.length) {
    lines.push("# Set these first:");
    const width = Math.max(...used.map((n) => upper(n).length));
    for (const n of used) lines.push(`#   ${upper(n).padEnd(width)}  ${varDoc(table.byName(n)!, calls)}`);
  }
  if (t.query.some(([, v]) => markersIn(v).length) || t.pathSegs.some((s) => markersIn(s).length)) {
    lines.push("# Values placed in the URL must be URL-encoded.");
  }
  lines.push(`BASE_URL=${JSON.stringify(call.origin)}`);
  const cmd: string[] = [`curl -sS -X ${call.method} "${url}"`];
  if (t.body.kind === "json") cmd.push(`-H "Content-Type: ${t.call.requestMime || "application/json"}"`);
  if ((call.responseMime ?? "").includes("json")) cmd.push(`-H "Accept: application/json"`);
  for (const [k, v] of t.headers) cmd.push(`-H "${shLit(k)}: ${sh(v)}"`);
  if (!["GET", "HEAD"].includes(call.method)) cmd.push(`-H "Origin: \${BASE_URL}"`);
  if (t.cookies.length) cmd.push(`-b "${t.cookies.map(([k, v]) => `${shLit(k)}=${sh(v)}`).join("; ")}"`);
  let heredoc = "";
  const b = t.body;
  if (b.kind === "json") {
    const json = JSON.stringify(b.value, null, 2).replace(/"\u27e6#([A-Za-z0-9_$]+)\u27e7"/g, (_m, n) => `${L}${n}${R}`);
    cmd.push("--data-binary @- <<JSON");
    heredoc = parts(json).map((x) => ("lit" in x ? x.lit.replace(/([\\$`])/g, "\\$1") : `\${${upper(x.v)}}`)).join("") + "\nJSON";
  } else if (b.kind === "form") {
    for (const f of b.fields) cmd.push(`--data-urlencode "${shLit(f.name)}=${sh(f.value)}"`);
  } else if (b.kind === "multipart") {
    for (const f of b.fields) cmd.push(f.value.startsWith("(file:") ? `-F "${shLit(f.name)}=@/path/to/file"` : `-F "${shLit(f.name)}=${sh(f.value)}"`);
  } else if (b.kind === "text") {
    if (t.call.requestMime) cmd.push(`-H "Content-Type: ${t.call.requestMime}"`);
    cmd.push(`--data-raw "${sh(b.text)}"`);
  }
  lines.push(cmd.join(" \\\n  ") + (heredoc ? `\n${heredoc}` : ""));
  return lines.join("\n");
}

// ---------- in-browser verification snippet ----------

function pathKeys(path: string): (string | number)[] {
  return [...path.matchAll(/\.([A-Za-z_]\w*)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/g)].map((m) =>
    m[1] !== undefined ? m[1] : m[2] !== undefined ? Number(m[2]) : JSON.parse(`"${m[3]}"`),
  );
}

const HELPERS = `  const pick = (obj, keys) => keys.reduce((o, k) => (o == null ? o : o[k]), obj);
  const cache = {};
  const getJson = (url) => (cache[url] ??= fetch(url, { credentials: "include", headers: { Accept: "application/json" } }).then((r) => r.json()));
  const getDoc = (url) => (cache[url] ??= fetch(url, { credentials: "include" }).then((r) => r.text()).then((t) => new DOMParser().parseFromString(t, "text/html")));
  const cookie = (name) => (document.cookie.split("; ").find((c) => c.startsWith(name + "=")) || "").slice(name.length + 1);
  const fromStorage = (hint) => {
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i), val = store.getItem(key) || "";
        if (key.toLowerCase().includes(hint.toLowerCase()) && val.length > 15 && !val.startsWith("{")) return val;
        const jwt = /eyJ[\\w-]{8,}\\.[\\w-]{8,}\\.[\\w-]*/.exec(val);
        if (jwt && /token|auth|jwt|bearer/i.test(hint)) return jwt[0];
      }
    }
    return undefined;
  };
  const shapeOf = (x, d = 0) =>
    x === null ? "null" : Array.isArray(x) ? [x.length ? shapeOf(x[0], d + 1) : "empty"] :
    typeof x === "object" ? (d > 4 ? "object" : Object.fromEntries(Object.keys(x).slice(0, 40).map((k) => [k, shapeOf(x[k], d + 1)]))) : typeof x;`;

function renderVerify(call: Call, calls: Call[]): string {
  const table = new VarTable();
  const target = templateCall(call, table);
  const inputs: Var[] = [];
  const steps: string[] = [];
  const done = new Set<string>();

  const resolve = (t: Templated, depth: number): void => {
    for (const name of usedOutsideCookies(t)) {
      if (done.has(name)) continue;
      done.add(name);
      const v = table.byName(name)!;
      const s = v.source;
      if (s.kind === "input" || s.kind === "literal") {
        inputs.push(v);
        continue;
      }
      if (s.kind === "secret") {
        const hint = s.token.replace(/^\{\{secret:|(~\d+)?\}\}$/g, "");
        steps.push(`  // ${name}: its origin is not in the recording, so look in browser storage, else fill it in by hand.\n  v.${name} = fromStorage(${JSON.stringify(hint)}) ?? "FILL_ME";`);
        continue;
      }
      const src = calls[s.callIndex];
      const what = describeSource(s, calls);
      if (s.via === "set-cookie") {
        steps.push(`  // ${name} <- cookie ${s.path} (${what})\n  v.${name} = cookie(${JSON.stringify(s.path)});`);
        continue;
      }
      const replayable = src && src.method === "GET" && depth < 3;
      if (!replayable || s.via === "header" || s.via === "html-link") {
        const fallback =
          s.via === "html-meta"
            ? `document.querySelector(${JSON.stringify(`meta[name="${s.path}"]`)})?.content ?? "FILL_ME"`
            : s.via === "html-input"
              ? `document.querySelector(${JSON.stringify(`[name="${s.path}"]`)})?.value ?? "FILL_ME"`
              : `"FILL_ME"`;
        steps.push(`  // ${name} <- ${what}\n  // That response cannot be re-fetched safely from here; fill it in if it is not on the current page.\n  v.${name} = ${fallback};`);
        continue;
      }
      const st = templateCall(src, table);
      if (usedOutsideCookies(st).includes(name)) {
        steps.push(`  // ${name} <- ${what}\n  // Fetching that needs the value itself, so fill it in by hand.\n  v.${name} = "FILL_ME";`);
        continue;
      }
      resolve(st, depth + 1);
      const url = jsUrl(st, tplLit(src.origin), "v");
      if (s.via === "json") {
        steps.push(`  // ${name} <- ${what}\n  v.${name} = pick(await getJson(${url}), ${JSON.stringify(pathKeys(s.path))});`);
      } else {
        const sel = s.via === "html-meta" ? `meta[name="${s.path}"]` : `[name="${s.path}"]`;
        const attr = s.via === "html-meta" ? "content" : "value";
        steps.push(`  // ${name} <- ${what}\n  v.${name} = (await getDoc(${url})).querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(attr)});`);
      }
    }
  };
  resolve(target, 0);

  const mutating = !["GET", "HEAD"].includes(call.method);
  const body = jsBody(target, "v", "      ");
  const inputLines = inputs.map(
    (v) => `    ${v.name}: ${v.source.kind === "literal" ? (v.numeric ? v.example : JSON.stringify(v.example)) : JSON.stringify("CHANGE_ME")}, // ${describeSource(v.source, calls)}`,
  );
  return [
    `// Verify: ${shortId(call)}`,
    `// Paste into the DevTools console (F12 -> Console) on the portal tab while logged in.`,
    `// It only talks to the portal, using the session you already have, and reports the`,
    `// response structure (field names and types), never the values.`,
    `(async () => {`,
    mutating
      ? `  const SEND = false; // This call CHANGES DATA. Check the printed request, then set to true to really send it.`
      : `  const SEND = true; // Read-only call.`,
    `  const v = {`,
    ...inputLines,
    `  };`,
    HELPERS,
    `  const result = { endpoint: ${JSON.stringify(shortId(call))}, sent: false, steps: {} };`,
    `  try {`,
    ...steps.map((s) => s.replace(/^/gm, "  ")),
    `    for (const [k, val] of Object.entries(v)) result.steps[k] = val == null || val === "FILL_ME" || val === "CHANGE_ME" ? "MISSING" : "ok";`,
    `    const request = {`,
    `      method: ${JSON.stringify(call.method)},`,
    `      headers: ${jsHeaders(target, "v", false, "      ")},`,
    ...(body ? [`      body: ${body},`] : []),
    `      credentials: "include",`,
    `    };`,
    `    const url = ${jsUrl(target, tplLit(call.origin), "v")};`,
    `    console.log("Request:", url, request);`,
    `    if (SEND) {`,
    `      const res = await fetch(url, request);`,
    `      const type = res.headers.get("content-type") || "";`,
    `      Object.assign(result, { sent: true, status: res.status, redirected: res.redirected, contentType: type });`,
    `      result.shape = type.includes("json") ? shapeOf(await res.json()) : "(" + (await res.text()).length + " chars, not JSON)";`,
    `    }`,
    `  } catch (err) {`,
    `    result.error = String(err);`,
    `  }`,
    `  const out = JSON.stringify(result, null, 2);`,
    `  console.log(out);`,
    `  try { copy(out); console.log("Result copied to the clipboard. Paste it back into the capture page."); } catch {}`,
    `})();`,
  ].join("\n");
}

export function buildArtifacts(call: Call, calls: Call[]): Artifacts {
  const table = new VarTable();
  const t = templateCall(call, table);
  const used = markersIn(
    ...t.pathSegs,
    ...t.query.map((q) => q[1]),
    ...t.headers.map((h) => h[1]),
    ...t.cookies.map((c) => c[1]),
    ...bodyStrings(t.body),
  );
  return {
    curl: renderCurl(call, calls),
    typescript: renderTypescript(call, calls),
    verify: renderVerify(call, calls),
    variables: used.map((n) => {
      const v = table.byName(n)!;
      return { name: v.name, from: describeSource(v.source, calls), example: v.example.length > 60 ? v.example.slice(0, 57) + "…" : v.example };
    }),
  };
}

// ---------- OpenAPI ----------

export function buildOpenApi(endpoints: Endpoint[], calls: Call[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const hostCount = new Map<string, number>();
  for (const ep of endpoints) hostCount.set(ep.host, (hostCount.get(ep.host) ?? 0) + ep.calls.length);
  const mainHost = [...hostCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const origin = calls.find((c) => c.host === mainHost)?.origin ?? "https://portal.invalid";
  for (const ep of endpoints) {
    if (ep.host !== mainHost) continue;
    const sample = calls[ep.sampleCall];
    const key = ep.operation ? `${ep.pathTemplate}#${ep.operation.replace(/\s+/g, ":")}` : ep.pathTemplate;
    const parameters = [
      ...ep.pathParams.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
      ...ep.queryParams.map((name) => ({ name, in: "query", schema: { type: "string" } })),
    ];
    const op: Record<string, unknown> = {
      operationId: fnName(sample),
      summary: `${ep.id} (observed ${ep.calls.length}x)`,
      ...(parameters.length ? { parameters } : {}),
      responses: Object.fromEntries(
        ep.statuses.map((s) => [
          String(s || "default"),
          {
            description: `Observed status ${s}`,
            ...(ep.responseShape && s >= 200 && s < 300
              ? { content: { [ep.responseMime || "application/json"]: { schema: toJsonSchema(ep.responseShape) } } }
              : {}),
          },
        ]),
      ),
      "x-relevance-score": ep.score,
    };
    if (ep.requestShape) {
      op.requestBody = { content: { [ep.requestMime || "application/json"]: { schema: toJsonSchema(ep.requestShape) } } };
    } else if (ep.requestFields?.length) {
      op.requestBody = {
        content: {
          [ep.requestMime || "application/x-www-form-urlencoded"]: {
            schema: { type: "object", properties: Object.fromEntries(ep.requestFields.map((f) => [f, { type: "string" }])) },
          },
        },
      };
    }
    (paths[key] ??= {})[ep.method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: `Reverse-engineered API for ${mainHost ?? "portal"}`,
      version: "0.0.1",
      description: "Inferred from a single browser recording. Optional fields, enums and error responses that did not occur in the recording are missing.",
    },
    servers: [{ url: origin }],
    paths,
  };
}

// ---------- Markdown report (CLI output and export) ----------

export function buildMarkdown(report: Report): string {
  const out: string[] = [];
  const m = report.meta;
  out.push(`# API report: ${report.workflow.description || "(no workflow description)"}`, "");
  out.push(`${m.entries} recorded requests, ${m.kept} kept after noise filtering, ${report.endpoints.length} distinct endpoints on ${m.hosts.join(", ") || "-"}.`, "");
  if (report.warnings.length) out.push("## Warnings", "", ...report.warnings.map((w) => `- ${w}`), "");
  if (report.llm.used) {
    out.push(`## Verdict (${report.llm.model}, confidence ${report.llm.confidence})`, "", report.llm.explanation, "");
    for (const c of report.llm.caveats) out.push(`- Caveat: ${c}`);
    if (report.llm.nextCapture) out.push(`- Suggested next recording: ${report.llm.nextCapture}`);
    out.push("");
  }
  if (report.auth.length) {
    out.push("## Authentication", "");
    for (const a of report.auth) out.push(`- **${a.type}** \`${a.name}\`: ${a.detail} (used by ${a.usedBy} calls)`);
    out.push("");
  }
  out.push("## Ranked candidates", "", "| # | Score | Endpoint | Calls | Status |", "|---|---|---|---|---|");
  report.endpoints.slice(0, 15).forEach((ep, i) => {
    const pick = report.selected.includes(ep.id) ? " **(selected)**" : "";
    out.push(`| ${i + 1} | ${ep.score} | \`${ep.method} ${ep.pathTemplate}${ep.operation ? ` [${ep.operation}]` : ""}\`${pick} | ${ep.calls.length} | ${ep.statuses.join(", ")} |`);
  });
  out.push("");
  for (const id of report.selected) {
    const ep = report.endpoints.find((e) => e.id === id);
    const art = report.artifacts[id];
    if (!ep || !art) continue;
    out.push(`## ${ep.method} ${ep.pathTemplate}${ep.operation ? ` [${ep.operation}]` : ""}`, "");
    out.push("Why it ranked here:", "", ...ep.reasons.map((r) => `- ${r}`), "");
    if (art.variables.length) {
      out.push("Where each dynamic value comes from:", "", "| Variable | Origin |", "|---|---|");
      for (const v of art.variables) out.push(`| \`${v.name}\` | ${v.from.replace(/\|/g, "\\|")} |`);
      out.push("");
    }
    if (ep.requestShape) out.push(`Request body: \`${summarizeShape(ep.requestShape)}\``, "");
    if (ep.requestFields?.length) out.push(`Form fields: \`${ep.requestFields.join(", ")}\``, "");
    if (ep.responseShape) out.push(`Response: \`${summarizeShape(ep.responseShape)}\``, "");
    out.push("```bash", art.curl, "```", "", "```ts", art.typescript, "```", "", "Verification snippet (run in the portal's DevTools console):", "", "```js", art.verify, "```", "");
  }
  return out.join("\n");
}
