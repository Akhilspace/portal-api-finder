// Turn concrete requests into endpoints: template the path, find the "operation" for
// endpoints that multiplex many actions over one URL, and parse request bodies.

import { HarEntry, NameValue, baseMime, hasToken, header, safeDecode, tryJson } from "./har.ts";

export interface PathParam {
  name: string;
  index: number;
  value: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDynamicSegment(seg: string): boolean {
  if (!seg) return false;
  if (hasToken(seg)) return true;
  if (/^\d+$/.test(seg)) return true;
  if (UUID.test(seg)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(seg)) return true;
  if (/^[0-9a-f]{12,}$/i.test(seg)) return true;
  if (/^[0-9a-f]{8,}$/i.test(seg) && /\d/.test(seg) && /[a-f]/i.test(seg)) return true;
  if (seg.length >= 20 && /\d/.test(seg) && !seg.includes(".")) return true;
  const digits = seg.replace(/\D/g, "").length;
  if (digits >= 3 && seg.length >= 5 && !/\.[a-z]{2,5}$/i.test(seg)) return true;
  return false;
}

function singular(word: string): string {
  if (/ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(ses|xes|ches|shes)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}

export function camel(s: string): string {
  const parts = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => (/^[A-Z0-9]+$/.test(p) ? p.toLowerCase() : p));
  if (!parts.length) return "value";
  const out = parts
    .map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("");
  return /^\d/.test(out) ? `v${out}` : out;
}

export function templatePath(pathname: string): { template: string; params: PathParam[] } {
  const segs = pathname.split("/");
  const params: PathParam[] = [];
  const used = new Set<string>();
  const out = segs.map((raw, index) => {
    const seg = safeDecode(raw);
    if (!isDynamicSegment(seg)) return raw;
    let prev = "";
    for (let j = index - 1; j >= 0; j--) {
      if (segs[j] && !isDynamicSegment(safeDecode(segs[j]))) {
        prev = segs[j];
        break;
      }
    }
    let name = prev ? camel(singular(prev)) + "Id" : "id";
    let n = 2;
    const base = name;
    while (used.has(name)) name = `${base}${n++}`;
    used.add(name);
    params.push({ name, index, value: seg });
    return `{${name}}`;
  });
  return { template: out.join("/") || "/", params };
}

export type ParsedBody =
  | { kind: "none" }
  | { kind: "json"; value: unknown }
  | { kind: "form"; fields: NameValue[] }
  | { kind: "multipart"; fields: NameValue[] }
  | { kind: "text"; text: string };

export function parseRequestBody(e: HarEntry): ParsedBody {
  const pd = e.request.postData;
  if (!pd) return { kind: "none" };
  const mime = baseMime(pd.mimeType ?? header(e.request.headers, "content-type"));
  const text = pd.text ?? "";
  if (mime.includes("multipart")) {
    const fields = (pd.params ?? []).map((p) => ({ name: p.name, value: p.fileName ? `(file: ${p.fileName})` : p.value ?? "" }));
    if (!fields.length) {
      const re = /name="([^"]+)"(?:; filename="([^"]*)")?[^\n]*\r?\n(?:[^\n]*\r?\n)*?\r?\n([\s\S]*?)\r?\n--/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) fields.push({ name: m[1], value: m[2] !== undefined ? `(file: ${m[2]})` : m[3] });
    }
    return { kind: "multipart", fields };
  }
  if (mime.includes("x-www-form-urlencoded")) {
    const fields = pd.params?.length
      ? pd.params.map((p) => ({ name: safeDecode(p.name), value: safeDecode((p.value ?? "").replace(/\+/g, " ")) }))
      : [...new URLSearchParams(text)].map(([name, value]) => ({ name, value }));
    return { kind: "form", fields };
  }
  const json = tryJson(text);
  if (json.ok && (mime.includes("json") || mime.includes("graphql") || typeof json.value === "object")) {
    return { kind: "json", value: json.value };
  }
  if (!text && !pd.params?.length) return { kind: "none" };
  if (!text && pd.params?.length) {
    return { kind: "form", fields: pd.params.map((p) => ({ name: p.name, value: p.value ?? "" })) };
  }
  return { kind: "text", text };
}

const ACTION_PARAM = /^(action|act|cmd|command|op|operation|do|task|mode|func|function|method|route|event|__EVENTTARGET)$/i;
const SCRIPT_PATH = /\.(php|aspx?|do|cgi|jsp|cfm|pl|ashx|asmx)$|\/(index|ajax|rpc|api|handler|service|controller)$/i;

/** Name of the operation for URLs that carry many actions (GraphQL, JSON-RPC, SOAP, ?action=). */
export function operationOf(e: HarEntry, body: ParsedBody, pathname: string): string | undefined {
  if (body.kind === "json" && body.value && typeof body.value === "object" && !Array.isArray(body.value)) {
    const b = body.value as Record<string, unknown>;
    if (typeof b.query === "string" && /^\s*(query|mutation|subscription|\{)/.test(b.query)) {
      if (typeof b.operationName === "string" && b.operationName) return `graphql ${b.operationName}`;
      const m = /^\s*(query|mutation|subscription)\s+(\w+)/.exec(b.query);
      const field = /\{\s*(\w+)/.exec(b.query);
      return `graphql ${m?.[2] ?? field?.[1] ?? "anonymous"}`;
    }
    if (typeof b.jsonrpc === "string" && typeof b.method === "string") return `rpc ${b.method}`;
  }
  const soap = header(e.request.headers, "soapaction");
  if (soap) return `soap ${soap.replace(/"/g, "").split(/[/#]/).pop()}`;
  if (SCRIPT_PATH.test(pathname)) {
    const candidates: NameValue[] = [...(e.request.queryString ?? [])];
    if (body.kind === "form" || body.kind === "multipart") candidates.push(...body.fields);
    const hit = candidates.find((p) => ACTION_PARAM.test(p.name) && /^[\w.$:-]{1,60}$/.test(p.value) && !hasToken(p.value));
    if (hit) return `${hit.name}=${hit.value}`;
  }
  return undefined;
}
