// Heuristic ranking. Deterministic, explainable, and good enough on its own for clear cases;
// the LLM step refines it, it does not replace it.

import type { Call } from "./types.ts";

const STOP = new Set(
  "the a an and or of for to in on at by with from into then this that it is are be as new page click button form field fields screen open go user users staff clinic portal using via when after before their them our your".split(" "),
);
const WRITE_WORDS = /\b(creat\w*|add\w*|book\w*|schedul\w*|submit\w*|sav\w*|post\w*|register\w*|enter\w*|updat\w*|edit\w*|chang\w*|modif\w*|delet\w*|remov\w*|cancel\w*|upload\w*|send\w*|assign\w*|approv\w*|record\w*|log\s+a|check[- ]?in|resched\w*|bill\w*|charg\w*|pay\w*|refill\w*|order\w*|sign\w*)\b/i;
const READ_WORDS = /\b(search\w*|find\w*|look\s?up|list\w*|view\w*|get\w*|show\w*|export\w*|download\w*|fetch\w*|read\w*|check\w*|retriev\w*|pull\w*|load\w*|open\w*|display\w*|report\w*|eligib\w*|verif\w*)\b/i;
const TELEMETRY = /(^|[\/_.-])(telemetry|analytics|track(ing)?|beacon|heartbeat|keep-?alive|ping|metrics?|collect|logs?|logging|rum|csp-report|presence|unread-?count)(\/|$|\.)/i;

export function stem(w: string): string {
  let s = w.toLowerCase();
  if (s.length > 4) s = s.replace(/ies$/, "y").replace(/(ing|ed|es|s)$/, "");
  return s;
}

export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

export function detectIntent(description: string): "read" | "write" | "unknown" {
  const w = WRITE_WORDS.test(description);
  const r = READ_WORDS.test(description);
  if (w) return "write"; // "search for a patient and book an appointment" is a write workflow
  if (r) return "read";
  return "unknown";
}

function matches(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  return n >= 4 && (a.startsWith(b) || b.startsWith(a));
}

function bodyKeys(call: Call): string[] {
  if (call.body.kind === "form" || call.body.kind === "multipart") return call.body.fields.map((f) => f.name);
  if (call.body.kind !== "json") return [];
  const keys: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== "object" || depth > 5 || keys.length > 200) return;
    if (Array.isArray(v)) return v.slice(0, 5).forEach((x) => walk(x, depth + 1));
    for (const [k, x] of Object.entries(v)) {
      keys.push(k);
      walk(x, depth + 1);
    }
  };
  walk(call.body.value, 0);
  return keys;
}

export function scoreCall(
  call: Call,
  description: string,
  intent: "read" | "write" | "unknown",
  repeatCount: number,
  declaredInputs?: string[],
): void {
  let score = 0;
  const reasons: string[] = [];
  const add = (n: number, why: string) => {
    score += n;
    reasons.push(`${n > 0 ? "+" : ""}${n} ${why}`);
  };
  const mutating = !["GET", "HEAD"].includes(call.method);

  if (call.kind === "api") add(1, "data request (xhr/fetch), not a page or asset");
  else if (mutating) add(1, "form post");
  else add(-1, "plain page load");

  if (intent === "write") {
    if (mutating) add(4, `${call.method} changes state and the workflow describes a change`);
  } else if (intent === "read") {
    if (!mutating && call.kind === "api") add(2.5, "GET data request and the workflow describes a lookup");
    else if (mutating) add(0.5, "non-GET request (some portals search via POST)");
  } else if (mutating) add(2.5, `${call.method} changes state`);

  // Only values declared for this workflow count; a recording may contain other typed values.
  const inputs = new Set(
    call.bindings
      .filter((b) => b.source.kind === "input")
      .map((b) => (b.source as { label: string }).label)
      .filter((label) => !declaredInputs?.length || declaredInputs.includes(label.replace(/~\d+$/, ""))),
  );
  if (inputs.size) add(Math.min(10, inputs.size * 4), `carries what the recorder typed: ${[...inputs].join(", ")}`);

  const want = [...new Set(words(description).map(stem))];
  const urlWords = new Set(words(`${call.pathTemplate} ${call.operation ?? ""}`).map(stem));
  const urlHits = want.filter((w) => [...urlWords].some((u) => matches(w, u)));
  if (urlHits.length) add(Math.min(4.5, urlHits.length * 1.5), `URL mentions ${urlHits.join(", ")}`);
  const keyWords = new Set(words([...bodyKeys(call), ...call.query.map((q) => q.name)].join(" ")).map(stem));
  const keyHits = want.filter((w) => !urlHits.includes(w) && [...keyWords].some((u) => matches(w, u)));
  if (keyHits.length) add(Math.min(2.25, keyHits.length * 0.75), `parameters mention ${keyHits.join(", ")}`);

  if (call.status >= 200 && call.status < 400) add(0.5, `succeeded (${call.status})`);
  else if (call.status >= 400) add(-1.5, `failed (${call.status})`);
  if ((call.responseMime ?? "").includes("json")) add(0.5, "JSON response");

  if (TELEMETRY.test(call.path + "/")) add(-5, "looks like telemetry / polling");
  if (repeatCount >= 4 && !mutating) add(-2, `identical request repeated ${repeatCount}x (polling)`);
  const hasPassword =
    (call.body.kind === "form" || call.body.kind === "json") &&
    JSON.stringify(call.body).match(/"[^"]*(password|passwd|pwd)[^"]*"/i);
  if (hasPassword && !/\b(log\s?in|sign\s?in|auth\w*)\b/i.test(description)) add(-3, "login request, not the workflow itself");

  call.score = Math.round(score * 100) / 100;
  call.reasons = reasons;
}
