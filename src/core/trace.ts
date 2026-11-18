// Value provenance. For every dynamic value a request sends, find the earlier response that
// first contained it. This is what turns "here is a request" into "here is how to make this
// request yourself": the CSRF token comes from this page, the patient id from that search.

import { HarEntry, NameValue, baseMime, hasToken, header, responseText, safeDecode, safeUrl, tryJson } from "./har.ts";
import { isDynamicSegment, ParsedBody } from "./normalize.ts";
import { parseAttrs } from "./scrub.ts";
import type { Binding, Loc, Source, Via } from "./types.ts";

interface Origin {
  callIndex: number;
  endpointId: string;
  via: Via;
  path: string;
}

const WHOLE_TOKEN = /^\{\{secret:[^}]+\}\}$/;
const ID_NAME = /(^|[^a-z])(id|ids|key|code|no|num|number|ref|uuid|pid|eid)$/i;

function lastKey(path: string): string {
  const m = /([A-Za-z0-9_-]+)(\[\d*\])*$/.exec(path);
  return m ? m[1] : path;
}

/** Is this value distinctive enough that equality implies data flow? */
function eligible(v: string): boolean {
  if (WHOLE_TOKEN.test(v)) return true;
  if (hasToken(v)) return false; // typed inputs are labelled directly, never traced
  if (v.length > 512) return false;
  if (/^\d+$/.test(v)) return v.length >= 4;
  if (/^[A-Za-z]+$/.test(v) && v.length < 16) return false; // plain words collide by chance
  return v.length >= 5;
}

const norm = (s: string) => lastKey(s).toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^x(?=csrf|xsrf|auth|api)/, "");
const TIER: Record<Via, number> = { json: 3, "html-input": 3, "html-meta": 3, "set-cookie": 2, header: 2, "html-link": 0 };

export class ValueIndex {
  private exact = new Map<string, Origin[]>();
  private shortIds = new Map<string, Origin>();
  /** Values the client sent before any response contained them: they originate client-side. */
  private sent = new Set<string>();

  markSent(value: string): void {
    const v = value.trim();
    if (!this.exact.has(v) && !this.shortIds.has(v)) this.sent.add(v);
  }

  add(value: unknown, origin: Origin): void {
    if (typeof value === "number") value = String(value);
    if (typeof value !== "string") return;
    const v = value.trim();
    if (this.sent.has(v)) return; // a response echoing a request value is not its origin
    if (eligible(v)) {
      const list = this.exact.get(v);
      if (!list) this.exact.set(v, [origin]);
      else if (list.length < 24) list.push(origin);
      else list[list.length - 1] = origin;
    } else if (/^\d{1,3}$/.test(v) && ID_NAME.test(lastKey(origin.path))) {
      if (!this.shortIds.has(v)) this.shortIds.set(v, origin);
    }
  }

  /**
   * Best origin for a request value. A value often appears in several earlier responses
   * (a CSRF token in a page <meta> and again in a form's hidden input); prefer a structured
   * source, then one whose field name matches the request field, then the most recent.
   */
  find(value: string, nameHint: string, loc: Loc, isPathParam: boolean): Origin | undefined {
    const v = value.trim();
    const list = this.exact.get(v);
    if (list?.length) {
      const want = norm(nameHint);
      let best: Origin | undefined;
      let bestScore = -1;
      for (const o of list) {
        const score = (loc === "cookie" && o.via === "set-cookie" ? 6 : TIER[o.via]) + (norm(o.path) === want ? 4 : 0) + o.callIndex / 1e6;
        if (score > bestScore) [best, bestScore] = [o, score];
      }
      return best;
    }
    // Short numeric ids ("42") only count when both sides are named like an id.
    if (/^\d{1,3}$/.test(v) && (isPathParam || ID_NAME.test(lastKey(nameHint)))) return this.shortIds.get(v);
    return undefined;
  }
}

function jsonLeaves(value: unknown, visit: (path: string, v: string | number) => void, path = "$", depth = 0, budget = { n: 4000 }): void {
  if (budget.n <= 0 || depth > 10 || value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number") {
    budget.n--;
    return visit(path, value);
  }
  if (Array.isArray(value)) {
    value.slice(0, 200).forEach((v, i) => jsonLeaves(v, visit, `${path}[${i}]`, depth + 1, budget));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      jsonLeaves(v, visit, /^[A-Za-z_]\w*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`, depth + 1, budget);
    }
  }
}

type Adder = Pick<ValueIndex, "add">;

function indexUrlParts(index: Adder, raw: string, base: Omit<Origin, "via" | "path">, via: Via, label: string): void {
  const u = safeUrl(raw.startsWith("http") ? raw : `http://x${raw.startsWith("/") ? "" : "/"}${raw}`);
  if (!u) return;
  for (const seg of u.pathname.split("/").map(safeDecode)) {
    if (isDynamicSegment(seg)) index.add(seg, { ...base, via, path: `${label} path` });
  }
  for (const [k, v] of u.searchParams) index.add(v, { ...base, via, path: `${label} ?${k}` });
}

/** Record every value a response exposes so later requests can be traced back to it. */
export function indexResponse(target: ValueIndex, e: HarEntry, callIndex: number, endpointId: string, ownRequestValues: Set<string>): void {
  const base = { callIndex, endpointId };
  // A response that repeats a value from its own request (an echoed id, a re-set cookie)
  // is not where that value comes from.
  const index: Adder = {
    add: (value, origin) => {
      if (!ownRequestValues.has(String(value).trim())) target.add(value, origin);
    },
  };
  const cookies: NameValue[] = [...(e.response.cookies ?? [])];
  for (const h of e.response.headers) {
    const n = h.name.toLowerCase();
    if (n === "set-cookie") {
      for (const line of h.value.split(/\n/)) {
        const first = line.split(";")[0];
        const i = first.indexOf("=");
        if (i > 0) cookies.push({ name: first.slice(0, i).trim(), value: first.slice(i + 1).trim() });
      }
    } else if (n === "location") {
      index.add(h.value, { ...base, via: "header", path: "Location" });
      indexUrlParts(index, h.value, base, "header", "Location");
    } else if (n.startsWith("x-") || /token|csrf|xsrf/.test(n)) {
      index.add(h.value, { ...base, via: "header", path: h.name });
    }
  }
  for (const c of cookies) index.add(c.value, { ...base, via: "set-cookie", path: c.name });

  const text = responseText(e);
  if (!text) return;
  const json = tryJson(text);
  if (json.ok) {
    jsonLeaves(json.value, (path, v) => index.add(v, { ...base, via: "json", path }));
    return;
  }
  const mime = baseMime(e.response.content?.mimeType);
  if (mime.includes("html") || /<(input|meta|form)\b/i.test(text)) {
    for (const tag of text.match(/<(input|meta|select|textarea)\b[^>]*>/gi) ?? []) {
      const a = parseAttrs(tag);
      if (/^<meta/i.test(tag)) {
        if (a.name && a.content) index.add(a.content, { ...base, via: "html-meta", path: a.name });
      } else if (a.name && a.value) {
        index.add(a.value, { ...base, via: "html-input", path: a.name });
      }
    }
    let links = 0;
    for (const m of text.matchAll(/\b(?:href|action|data-url|data-href)\s*=\s*["']([^"'#]+)["']/gi)) {
      if (++links > 400) break;
      indexUrlParts(index, m[1].replace(/&amp;/g, "&"), base, "html-link", "link");
    }
  }
}

interface RequestValue {
  in: Loc;
  name: string;
  value: string;
  match: string;
  isPathParam?: boolean;
}

const BORING_HEADER =
  /^(accept|accept-encoding|accept-language|cache-control|connection|content-length|content-type|cookie|dnt|host|origin|pragma|referer|user-agent|upgrade-insecure-requests|priority|te|if-none-match|if-modified-since)$|^(sec-|:)/i;

export function interestingHeaders(headers: NameValue[]): NameValue[] {
  return headers.filter((h) => !BORING_HEADER.test(h.name));
}

export function requestValues(
  pathParams: { name: string; value: string }[],
  query: NameValue[],
  headers: NameValue[],
  cookies: NameValue[],
  body: ParsedBody,
): RequestValue[] {
  const out: RequestValue[] = [];
  for (const p of pathParams) out.push({ in: "path", name: p.name, value: p.value, match: p.value, isPathParam: true });
  for (const q of query) out.push({ in: "query", name: q.name, value: q.value, match: q.value });
  for (const h of interestingHeaders(headers)) {
    const m = /^(Bearer|Basic|Token|Digest)\s+(.+)$/i.exec(h.value);
    out.push({ in: "header", name: h.name, value: h.value, match: m ? m[2] : h.value });
  }
  for (const c of cookies) out.push({ in: "cookie", name: c.name, value: c.value, match: c.value });
  if (body.kind === "json") {
    jsonLeaves(body.value, (path, v) => out.push({ in: "body", name: path, value: String(v), match: String(v) }));
  } else if (body.kind === "form" || body.kind === "multipart") {
    for (const f of body.fields) out.push({ in: "body", name: f.name, value: f.value, match: f.value });
  } else if (body.kind === "text") {
    // Line-based bodies such as DWR ("c0-param0=string:...") are not forms or JSON. Only lines that
    // carry a typed value or a secret are used, so tiny constants like "1" are not traced by mistake.
    for (const line of body.text.split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i <= 0) continue;
      const value = line.slice(i + 1);
      if (/\{\{(input|secret):[^}]+\}\}/.test(value)) out.push({ in: "body", name: line.slice(0, i).trim(), value, match: value });
    }
  }
  return out;
}
  
  

export function resolveBindings(index: ValueIndex, values: RequestValue[]): Binding[] {
  const out: Binding[] = [];
  for (const v of values) {
    let source: Source = { kind: "literal" };
    let match = v.match;
    const input = /\{\{input:([^}]+)\}\}/.exec(v.value);
    if (input) {
      source = { kind: "input", label: input[1] };
      match = input[0];
    } else {
      const hit = index.find(v.match, v.name, v.in, !!v.isPathParam);
      const secret = /\{\{secret:[^}]+\}\}/.exec(v.match);
      if (hit) source = { kind: "response", ...hit };
      else if (secret) {
        source = { kind: "secret", token: secret[0] };
        match = secret[0];
      }
    }
    if (source.kind === "literal") index.markSent(v.match);
    if (source.kind === "literal" && !v.isPathParam) continue; // constants are not bindings
    out.push({ in: v.in, name: v.name, value: v.value, match, source });
  }
  return out;
}

export function requestCookies(e: HarEntry): NameValue[] {
  if (e.request.cookies?.length) return e.request.cookies.map((c) => ({ name: c.name, value: c.value }));
  const raw = header(e.request.headers, "cookie");
  if (!raw) return [];
  return raw
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? { name: p, value: "" } : { name: p.slice(0, i), value: p.slice(i + 1) };
    });
}
