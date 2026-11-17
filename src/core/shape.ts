// Structural type inference for JSON-like values. Shapes carry no data values, which is
// what makes them safe to show to engineers and to send to an LLM.

export interface Shape {
  type: "string" | "number" | "boolean" | "null" | "object" | "array" | "mixed" | "unknown";
  format?: string;
  properties?: Record<string, Shape>;
  items?: Shape;
  optional?: boolean;
  nullable?: boolean;
}

function stringFormat(s: string): string | undefined {
  if (/^\{\{input:[^}]+\}\}$/.test(s)) return "typed-input";
  if (/^\{\{secret:[^}]+\}\}$/.test(s)) return "secret";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return "date-time";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return "date";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return "uuid";
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s)) return "email";
  if (/^https?:\/\//.test(s)) return "uri";
  if (/^\d+$/.test(s)) return "numeric-string";
  return undefined;
}

export function inferShape(value: unknown, depth = 0): Shape {
  if (value === null) return { type: "null" };
  if (value === undefined) return { type: "unknown" };
  if (typeof value === "string") {
    const format = stringFormat(value);
    return format ? { type: "string", format } : { type: "string" };
  }
  if (typeof value === "number") return { type: "number", format: Number.isInteger(value) ? "integer" : undefined };
  if (typeof value === "boolean") return { type: "boolean" };
  if (depth > 8) return { type: "unknown" };
  if (Array.isArray(value)) {
    let items: Shape | undefined;
    for (const v of value.slice(0, 25)) items = items ? mergeShapes(items, inferShape(v, depth + 1)) : inferShape(v, depth + 1);
    return { type: "array", items: items ?? { type: "unknown" } };
  }
  const properties: Record<string, Shape> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 80)) properties[k] = inferShape(v, depth + 1);
  return { type: "object", properties };
}

export function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.type === "unknown") return b;
  if (b.type === "unknown") return a;
  if (a.type === "null") return { ...b, nullable: true };
  if (b.type === "null") return { ...a, nullable: true };
  if (a.type !== b.type) return { type: "mixed", nullable: a.nullable || b.nullable };
  const out: Shape = { ...a, nullable: a.nullable || b.nullable || undefined };
  if (a.format !== b.format) delete out.format;
  if (a.type === "object") {
    const props: Record<string, Shape> = {};
    const ap = a.properties ?? {};
    const bp = b.properties ?? {};
    for (const k of new Set([...Object.keys(ap), ...Object.keys(bp)])) {
      if (ap[k] && bp[k]) props[k] = mergeShapes(ap[k], bp[k]);
      else props[k] = { ...(ap[k] ?? bp[k]), optional: true };
    }
    out.properties = props;
  }
  if (a.type === "array") out.items = mergeShapes(a.items ?? { type: "unknown" }, b.items ?? { type: "unknown" });
  return out;
}

/** Compact one-line rendering, e.g. `{id: integer, slots: [{start: date-time}]}`. */
export function summarizeShape(s: Shape | undefined, maxDepth = 3, maxKeys = 14): string {
  if (!s) return "-";
  const leaf = s.format ?? s.type;
  const q = s.nullable ? "?" : "";
  if (s.type === "object") {
    const entries = Object.entries(s.properties ?? {});
    if (maxDepth <= 0) return `{…${entries.length} keys}`;
    const shown = entries
      .slice(0, maxKeys)
      .map(([k, v]) => `${k}${v.optional ? "?" : ""}: ${summarizeShape(v, maxDepth - 1, Math.max(4, maxKeys - 4))}`);
    if (entries.length > maxKeys) shown.push(`…+${entries.length - maxKeys}`);
    return `{${shown.join(", ")}}${q}`;
  }
  if (s.type === "array") return `[${summarizeShape(s.items, maxDepth - 1, maxKeys)}]${q}`;
  return leaf + q;
}

export function toJsonSchema(s: Shape | undefined): Record<string, unknown> {
  if (!s || s.type === "unknown" || s.type === "mixed") return {};
  if (s.type === "null") return { type: "null" };
  const t = (type: string) => (s.nullable ? [type, "null"] : type);
  if (s.type === "object") {
    const props = s.properties ?? {};
    const required = Object.entries(props)
      .filter(([, v]) => !v.optional)
      .map(([k]) => k);
    return {
      type: t("object"),
      properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toJsonSchema(v)])),
      ...(required.length ? { required } : {}),
    };
  }
  if (s.type === "array") return { type: t("array"), items: toJsonSchema(s.items) };
  if (s.type === "number") return { type: t(s.format === "integer" ? "integer" : "number") };
  if (s.type === "string") {
    const fmt = s.format && ["date-time", "date", "uuid", "email", "uri"].includes(s.format) ? { format: s.format } : {};
    return { type: t("string"), ...fmt };
  }
  return { type: t(s.type) };
}
