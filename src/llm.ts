// Optional LLM step. The deterministic pipeline has already filtered, grouped, traced and
// ranked; the model's job is the part heuristics are bad at: reading the workflow description
// and the endpoint names like an engineer would, picking the call(s) that implement it, and
// saying what is still uncertain.
//
// The model only ever sees structure: endpoint templates, field names, shapes, and
// placeholder tokens. Free-text values are masked before the prompt is built.

import { describeSource, shortId } from "./core/generate.ts";
import { summarizeShape } from "./core/shape.ts";
import type { Call, LlmVerdict, Report } from "./core/types.ts";

const SYSTEM = `You help an integration engineer reverse-engineer the internal HTTP API of a clinic web portal from a browser recording (HAR).

You receive a workflow description and candidate endpoints observed while a clinic employee performed that workflow. The list is already noise-filtered and heuristically ranked (higher score = more likely). In all values, {{secret:NAME}} is a scrubbed credential and {{input:LABEL}} is a value the employee typed. "dependsOn" lists where each dynamic request value was first seen.

Decide which endpoint(s) actually perform the workflow.
- "primary": endpoint ids, in call order, that an integration must call to perform the workflow itself. Usually one. Never telemetry, polling, asset or login calls.
- "supporting": endpoint ids that must be called first to obtain values the primary call needs (record ids, CSRF tokens, slot ids), in call order.
- "parameters": for each primary endpoint, the request fields an integration must set, with a short plain-language meaning.
- "confidence": high only if the method, path and payload all clearly match the description.
- "caveats": concrete risks an engineer should check (for example a field that looks constant but may vary per patient, or a token that rotates).
- "nextCapture": if a second recording would resolve an ambiguity, say exactly what to record; otherwise null.

Use only endpoint ids from the input. Do not invent endpoints, fields or values. Respond with a single JSON object:
{"primary": string[], "supporting": string[], "explanation": string, "parameters": [{"endpointId": string, "name": string, "meaning": string}], "confidence": "high"|"medium"|"low", "caveats": string[], "nextCapture": string|null}`;

function mask(v: unknown, depth = 0): unknown {
  if (typeof v === "string") {
    if (/\{\{(secret|input):/.test(v)) return v;
    if (v.length > 32 || /\s/.test(v)) return "<text>";
    if (/^\d{5,}$/.test(v)) return "<number>";
    return v;
  }
  if (typeof v === "number") return Math.abs(v) >= 10000 ? "<number>" : v;
  if (Array.isArray(v)) return depth > 4 ? "[…]" : v.slice(0, 3).map((x) => mask(x, depth + 1));
  if (v && typeof v === "object") {
    if (depth > 4) return "{…}";
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 30).map(([k, x]) => [k, mask(x, depth + 1)]));
  }
  return v;
}

function requestExample(call: Call): unknown {
  const b = call.body;
  if (b.kind === "json") return mask(b.value);
  if (b.kind === "form" || b.kind === "multipart") return Object.fromEntries(b.fields.slice(0, 40).map((f) => [f.name, mask(f.value)]));
  if (b.kind === "text") return "<text body>";
  return undefined;
}

export function buildPrompt(report: Report, limit = 25): { system: string; user: string } {
  const candidates = report.endpoints.slice(0, limit).map((ep) => {
    const sample = report.calls[ep.sampleCall];
    return {
      id: ep.id,
      score: ep.score,
      kind: ep.kind,
      timesCalled: ep.calls.length,
      firstCallOrder: ep.calls[0],
      statuses: ep.statuses,
      query: sample.query.map((q) => `${q.name}=${mask(q.value)}`),
      requestExample: requestExample(sample),
      response: sample.responseShape ? summarizeShape(ep.responseShape, 3, 12) : `${sample.responseMime ?? "no body"}${sample.redirect ? `, redirects to ${sample.redirect}` : ""}`,
      dependsOn: sample.bindings
        .filter((b) => b.in !== "cookie")
        .map((b) => `${b.in} ${b.name} <- ${describeSource(b.source, report.calls)}`),
    };
  });
  const user = JSON.stringify(
    {
      workflow: report.workflow.description,
      typedInputs: report.workflow.inputs,
      authentication: report.auth.map((a) => `${a.type} ${a.name}: ${a.detail}`),
      candidates,
    },
    null,
    1,
  );
  return { system: SYSTEM, user };
}

const fallbackExplanation = (report: Report): string => {
  const ep = report.endpoints.find((e) => e.id === report.selected[0]);
  if (!ep) return "No request in the recording looks like it performs this workflow.";
  return `Heuristic pick: ${shortId(report.calls[ep.sampleCall])} scored highest (${ep.score}). ${ep.reasons.filter((r) => r.startsWith("+")).map((r) => r.replace(/^\+[\d.]+ /, "")).join("; ")}.`;
};

/** Mutates and returns the report with an LLM verdict (or a heuristic fallback verdict). */
export async function addVerdict(report: Report, env: Record<string, string | undefined> = process.env): Promise<Report> {
  const base: LlmVerdict = {
    used: false,
    primary: report.selected,
    supporting: [],
    explanation: fallbackExplanation(report),
    parameters: [],
    confidence: "low",
    caveats: [],
  };
  report.llm = base;
  const key = env.OPENAI_API_KEY;
  if (!key) {
    base.error = "OPENAI_API_KEY is not set; showing the heuristic ranking only.";
    return report;
  }
  if (!report.endpoints.length) return report;

  const model = env.OPENAI_MODEL || "gpt-4.1";
  const { system, user } = buildPrompt(report);
  try {
    const res = await fetch(`${(env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`OpenAI returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = JSON.parse(data.choices?.[0]?.message?.content ?? "{}") as Partial<LlmVerdict> & { nextCapture?: string | null };

    // Never trust ids the model returns: keep only endpoints that exist in the report.
    const known = new Set(report.endpoints.map((e) => e.id));
    const ids = (x: unknown) => (Array.isArray(x) ? x.filter((id): id is string => typeof id === "string" && known.has(id)) : []);
    const primary = ids(raw.primary);
    report.llm = {
      used: true,
      model,
      primary,
      supporting: ids(raw.supporting).filter((id) => !primary.includes(id)),
      explanation: typeof raw.explanation === "string" ? raw.explanation : "",
      parameters: Array.isArray(raw.parameters)
        ? raw.parameters.filter((p) => p && known.has(p.endpointId) && typeof p.name === "string").map((p) => ({ endpointId: p.endpointId, name: p.name, meaning: String(p.meaning ?? "") }))
        : [],
      confidence: raw.confidence === "high" || raw.confidence === "medium" ? raw.confidence : "low",
      caveats: Array.isArray(raw.caveats) ? raw.caveats.filter((c): c is string => typeof c === "string") : [],
      nextCapture: typeof raw.nextCapture === "string" && raw.nextCapture ? raw.nextCapture : undefined,
    };
    if (primary.length) report.selected = primary;
    else report.llm.caveats.push("The model did not identify a primary call; the heuristic pick is shown instead.");
  } catch (err) {
    base.error = `LLM step failed, showing the heuristic ranking: ${err instanceof Error ? err.message : String(err)}`;
    report.llm = base;
  }
  return report;
}
