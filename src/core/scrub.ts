// Scrubbing = tokenisation. It runs in the recorder's browser before anything is uploaded
// (and again on the server as defence in depth; it is idempotent).
//
// Every credential-like value and every value the recorder says they typed is replaced,
// everywhere it occurs in the HAR, by a stable placeholder:
//
//   session cookie  abc123...   ->  {{secret:PHPSESSID}}
//   csrf token      9f8e7d...   ->  {{secret:csrf_token}}
//   typed "Zztest"              ->  {{input:patient_last_name}}
//
// Because the same value always maps to the same placeholder, the later analysis can still
// follow a value from the response that produced it to the request that uses it, without
// the service ever seeing the value itself.

import {
  Har,
  HarEntry,
  NameValue,
  baseMime,
  decodeBase64Utf8,
  hasToken,
  isTextMime,
  tryJson,
} from "./har.ts";

export interface DeclaredInput {
  label: string;
  value: string;
}

export interface ScrubSummary {
  secrets: { token: string; kind: string; occurrences: number }[];
  inputs: { token: string; label: string; occurrences: number }[];
  skippedInputs: string[];
  bodiesDropped: number;
  bytesBefore: number;
  bytesAfter: number;
}

const SENSITIVE_NAME =
  /(pass(word|wd)?|pwd|secret|token|csrf|xsrf|api[-_]?key|auth(?!or)|session|sess(id)?$|sid$|jwt|bearer|signature|credential|otp|ssn)/i;
const PASSWORD_NAME = /(pass(word|wd)?|pwd|secret|ssn|otp)/i;
const NOT_A_SECRET_NAME = /(_type|_time|_at|expires|expiry|_in|_url|_uri|endpoint|enabled|required|method|scheme)$/i;
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const STATIC_MIME =
  /^(image\/|font\/|video\/|audio\/|text\/css|application\/(javascript|x-javascript|octet-stream|pdf|wasm|font|vnd\.ms-fontobject)|text\/javascript)/;
const MAX_BODY_CHARS = 1_500_000;

export function slug(s: string): string {
  return (
    s
      .trim()
      .replace(/[^A-Za-z0-9_.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "value"
  );
}

function looksOpaque(v: string): boolean {
  if (/^\d+$/.test(v)) return false; // bare numbers would break JSON bodies and are rarely secrets
  if (/^(true|false|null|undefined)$/i.test(v)) return false;
  return (v.length >= 8 && /\d/.test(v)) || v.length >= 20;
}

class Registry {
  byValue = new Map<string, string>();
  kindByToken = new Map<string, string>();
  labelByToken = new Map<string, string>();
  private nameCount = new Map<string, number>();

  add(prefix: "secret" | "input", kind: string, name: string, value: string, label?: string): void {
    const v = value.trim();
    if (!v || hasToken(v) || this.byValue.has(v)) return;
    const base = slug(name);
    const n = (this.nameCount.get(`${prefix}:${base}`) ?? 0) + 1;
    this.nameCount.set(`${prefix}:${base}`, n);
    const token = `{{${prefix}:${base}${n > 1 ? `~${n}` : ""}}}`;
    this.byValue.set(v, token);
    this.kindByToken.set(token, kind);
    if (label) this.labelByToken.set(token, label);
  }

  secret(kind: string, name: string, value: string | undefined): void {
    if (typeof value !== "string") return;
    const v = value.trim();
    if (PASSWORD_NAME.test(name) && kind !== "cookie") {
      if (v.length >= 4 && !/^(true|false|null)$/i.test(v)) this.add("secret", "password", name, v);
      return;
    }
    if (NOT_A_SECRET_NAME.test(name)) return;
    if (looksOpaque(v)) this.add("secret", kind, name, v);
  }
}

function parseCookieHeader(value: string): NameValue[] {
  return value
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? { name: p, value: "" } : { name: p.slice(0, i), value: p.slice(i + 1) };
    });
}

function parseSetCookie(value: string): NameValue[] {
  // HAR exporters join multiple Set-Cookie headers with newlines.
  return value
    .split(/\n/)
    .map((line) => parseCookieHeader(line)[0])
    .filter((c): c is NameValue => !!c && !!c.name);
}

export function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

function walkJsonLeaves(value: unknown, visit: (key: string, v: string) => void, key = "", depth = 0): void {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === "string") return visit(key, value);
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) walkJsonLeaves(item, visit, key, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) walkJsonLeaves(v, visit, k, depth + 1);
  }
}

function collectFromText(reg: Registry, text: string | undefined, mime: string | undefined): void {
  if (!text) return;
  for (const m of text.match(JWT_RE) ?? []) reg.add("secret", "jwt", "jwt", m);
  const json = tryJson(text);
  if (json.ok) {
    walkJsonLeaves(json.value, (key, v) => {
      if (SENSITIVE_NAME.test(key)) reg.secret("json", key, v);
    });
    return;
  }
  const m = baseMime(mime);
  if (m.includes("x-www-form-urlencoded")) {
    for (const [k, v] of new URLSearchParams(text)) if (SENSITIVE_NAME.test(k)) reg.secret("param", k, v);
    return;
  }
  if (m.includes("html") || /<(input|meta)\b/i.test(text)) {
    for (const tag of text.match(/<(input|meta)\b[^>]*>/gi) ?? []) {
      const a = parseAttrs(tag);
      const name = a.name ?? a.id ?? "";
      const val = /^<meta/i.test(tag) ? a.content : a.value;
      if (name && val && SENSITIVE_NAME.test(name)) reg.secret("html", name, val);
    }
  }
}

function collect(reg: Registry, e: HarEntry): void {
  for (const h of e.request.headers) {
    const n = h.name.toLowerCase();
    if (n === "cookie") {
      for (const c of parseCookieHeader(h.value)) reg.secret("cookie", c.name, c.value);
    } else if (n === "authorization" || n === "proxy-authorization") {
      const m = /^(\S+)\s+(.+)$/.exec(h.value.trim());
      const cred = m ? m[2] : h.value;
      if (cred.trim().length >= 6) reg.add("secret", "authorization", m ? m[1].toLowerCase() : "authorization", cred);
    } else if (SENSITIVE_NAME.test(n) && !n.startsWith("access-control-") && !n.startsWith("sec-")) {
      reg.secret("header", h.name, h.value);
    }
  }
  for (const c of e.request.cookies ?? []) reg.secret("cookie", c.name, c.value);
  for (const q of e.request.queryString ?? []) if (SENSITIVE_NAME.test(q.name)) reg.secret("param", q.name, q.value);
  for (const p of e.request.postData?.params ?? []) if (SENSITIVE_NAME.test(p.name)) reg.secret("param", p.name, p.value);
  collectFromText(reg, e.request.postData?.text, e.request.postData?.mimeType);

  for (const h of e.response.headers) {
    const n = h.name.toLowerCase();
    if (n === "set-cookie") {
      for (const c of parseSetCookie(h.value)) reg.secret("cookie", c.name, c.value);
    } else if (SENSITIVE_NAME.test(n) && !n.startsWith("access-control-") && n !== "www-authenticate") {
      reg.secret("header", h.name, h.value);
    }
  }
  for (const c of e.response.cookies ?? []) reg.secret("cookie", c.name, c.value);
  collectFromText(reg, e.response.content?.text, e.response.content?.mimeType);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scrubHar(input: Har, inputs: DeclaredInput[] = []): { har: Har; summary: ScrubSummary } {
  const bytesBefore = JSON.stringify(input).length;
  const har: Har = JSON.parse(JSON.stringify(input));
  let bodiesDropped = 0;

  // 1. Slim: bodies of static assets carry no API information and are most of the file size.
  for (const e of har.log.entries) {
    delete e._initiator;
    delete e.cache;
    const c = e.response.content;
    if (!c || typeof c.text !== "string") continue;
    const mime = baseMime(c.mimeType);
    const isStatic = STATIC_MIME.test(mime) || /^(image|font|stylesheet|script|media)$/.test(e._resourceType ?? "");
    if (c.encoding === "base64" && !isStatic && isTextMime(mime)) {
      try {
        c.text = decodeBase64Utf8(c.text);
        delete c.encoding;
      } catch {
        /* dropped below */
      }
    }
    if (isStatic || c.encoding === "base64" || c.text.length > MAX_BODY_CHARS) {
      delete c.text;
      delete c.encoding;
      (c as Record<string, unknown>).comment = "body dropped by scrubber";
      bodiesDropped++;
    }
  }

  // 2. Collect: typed inputs first (so a typed value is labelled as an input, not a secret).
  const reg = new Registry();
  const skippedInputs: string[] = [];
  for (const inp of inputs) {
    const v = (inp.value ?? "").trim();
    if (!inp.label?.trim() || !v) continue;
    if (v.length < 3) {
      skippedInputs.push(inp.label);
      continue;
    }
    reg.add("input", "input", inp.label, v, inp.label);
  }
  for (const e of har.log.entries) collect(reg, e);

  // 3. Replace everywhere, including URL-encoded spellings of each value.
  const lookup = new Map<string, string>();
  for (const [value, token] of reg.byValue) {
    lookup.set(value, token);
    const enc = encodeURIComponent(value);
    if (!lookup.has(enc)) lookup.set(enc, token);
    const form = enc.replace(/%20/g, "+");
    if (!lookup.has(form)) lookup.set(form, token);
  }
  const counts = new Map<string, number>();
  const keys = [...lookup.keys()].sort((a, b) => b.length - a.length);
  const re = keys.length ? new RegExp(keys.map(escapeRe).join("|"), "g") : null;
  const rep = (s: string): string => {
    if (!re || s.length < 3) return s;
    return s.replace(re, (m) => {
      const token = lookup.get(m)!;
      counts.set(token, (counts.get(token) ?? 0) + 1);
      return token;
    });
  };
  const repJson = (v: unknown): unknown => {
    if (typeof v === "string") return rep(v);
    if (typeof v === "number") {
      const token = lookup.get(String(v));
      if (token) counts.set(token, (counts.get(token) ?? 0) + 1);
      return token ?? v;
    }
    if (Array.isArray(v)) return v.map(repJson);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, repJson(x)]));
    }
    return v;
  };
  const repBody = (text: string): string => {
    // Bodies that are JSON are rewritten structurally so a replaced bare number stays valid JSON.
    const json = tryJson(text);
    if (json.ok && typeof json.value === "object" && json.value !== null) return JSON.stringify(repJson(json.value));
    return rep(text);
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return rep(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      for (const k of Object.keys(obj)) obj[k] = walk(obj[k]);
    }
    return node;
  };
  for (const e of har.log.entries) {
    const pd = e.request.postData;
    const bodyIn = pd?.text;
    const bodyOut = e.response.content?.text;
    if (pd && typeof bodyIn === "string") pd.text = "";
    if (e.response.content && typeof bodyOut === "string") e.response.content.text = "";
    walk(e);
    if (pd && typeof bodyIn === "string") pd.text = repBody(bodyIn);
    if (e.response.content && typeof bodyOut === "string") e.response.content.text = repBody(bodyOut);
  }

  const secrets: ScrubSummary["secrets"] = [];
  const inputsOut: ScrubSummary["inputs"] = [];
  for (const token of new Set(reg.byValue.values())) {
    const occurrences = counts.get(token) ?? 0;
    if (token.startsWith("{{input:")) {
      inputsOut.push({ token, label: reg.labelByToken.get(token) ?? token, occurrences });
    } else {
      secrets.push({ token, kind: reg.kindByToken.get(token) ?? "secret", occurrences });
    }
  }
  return {
    har,
    summary: {
      secrets,
      inputs: inputsOut,
      skippedInputs,
      bodiesDropped,
      bytesBefore,
      bytesAfter: JSON.stringify(har).length,
    },
  };
}
