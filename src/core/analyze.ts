// The deterministic pipeline: scrubbed HAR in, report out. No network, no LLM, runs anywhere.

import { Har, baseMime, header, responseText, safeDecode, safeUrl, tryJson } from "./har.ts";
import { classify } from "./filter.ts";
import { operationOf, parseRequestBody, templatePath } from "./normalize.ts";
import { inferShape, mergeShapes } from "./shape.ts";
import { ValueIndex, indexResponse, interestingHeaders, requestCookies, requestValues, resolveBindings } from "./trace.ts";
import { detectIntent, scoreCall } from "./rank.ts";
import { buildArtifacts, buildOpenApi, describeSource } from "./generate.ts";
import type { AuthFinding, Call, Endpoint, Report } from "./types.ts";

export interface AnalyzeOptions {
  description: string;
  inputs?: string[];
}

const PREVIEW_CHARS = 1500;

export function analyze(har: Har, opts: AnalyzeOptions): Report {
  const warnings: string[] = [];
  const entries = har.log.entries
    .map((e, harIndex) => ({ e, harIndex, t: Date.parse(e.startedDateTime) || 0 }))
    .sort((a, b) => a.t - b.t || a.harIndex - b.harIndex);

  const dropped: Record<string, number> = {};
  const hosts = new Map<string, number>();
  const calls: Call[] = [];
  const index = new ValueIndex();
  const intent = detectIntent(opts.description);

  for (const { e, harIndex } of entries) {
    const verdict = classify(e);
    if (!verdict.keep) {
      dropped[verdict.reason] = (dropped[verdict.reason] ?? 0) + 1;
      continue;
    }
    const url = safeUrl(e.request.url)!;
    const path = safeDecode(url.pathname);
    const { template, params } = templatePath(url.pathname);
    const body = parseRequestBody(e);
    const operation = operationOf(e, body, url.pathname);
    const method = e.request.method.toUpperCase();
    const endpointId = `${method} ${url.host}${safeDecode(template)}${operation ? ` [${operation}]` : ""}`;
    const query = (e.request.queryString?.length
      ? e.request.queryString
      : [...url.searchParams].map(([name, value]) => ({ name, value }))
    ).map((q) => ({ name: safeDecode(q.name), value: safeDecode(q.value.replace(/\+/g, " ")) }));
    const cookies = requestCookies(e);
    const headers = interestingHeaders(e.request.headers);
    const callIndex = calls.length;
    const values = requestValues(params, query, e.request.headers, cookies, body);

    const text = responseText(e);
    const json = tryJson(text);
    const call: Call = {
      index: callIndex,
      harIndex,
      startedAt: e.startedDateTime,
      method,
      url: e.request.url,
      origin: url.origin,
      host: url.host,
      path,
      pathTemplate: safeDecode(template),
      endpointId,
      operation,
      kind: verdict.kind,
      resourceType: e._resourceType,
      status: e.response.status,
      redirect: header(e.response.headers, "location") || e.response.redirectURL || undefined,
      requestMime: baseMime(e.request.postData?.mimeType ?? header(e.request.headers, "content-type")) || undefined,
      responseMime: baseMime(e.response.content?.mimeType) || undefined,
      query,
      headers,
      cookies,
      body,
      bindings: resolveBindings(index, values),
      responsePreview: text ? (text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + " …" : text) : undefined,
      responseShape: json.ok ? inferShape(json.value) : undefined,
      score: 0,
      reasons: [],
    };
    calls.push(call);
    hosts.set(url.host, (hosts.get(url.host) ?? 0) + 1);
    // Index after resolving, so a request can only be explained by strictly earlier responses.
    indexResponse(index, e, callIndex, endpointId, new Set(values.map((v) => v.match.trim())));
  }

  // Rank calls, then roll them up into endpoints.
  const repeats = new Map<string, number>();
  for (const c of calls) repeats.set(`${c.method} ${c.url}`, (repeats.get(`${c.method} ${c.url}`) ?? 0) + 1);
  for (const c of calls) scoreCall(c, opts.description, intent, repeats.get(`${c.method} ${c.url}`) ?? 1, opts.inputs);

  const byId = new Map<string, Endpoint>();
  for (const c of calls) {
    let ep = byId.get(c.endpointId);
    if (!ep) {
      ep = {
        id: c.endpointId,
        method: c.method,
        host: c.host,
        pathTemplate: c.pathTemplate,
        operation: c.operation,
        kind: c.kind,
        calls: [],
        statuses: [],
        pathParams: [],
        queryParams: [],
        sampleCall: c.index,
        score: -Infinity,
        reasons: [],
      };
      byId.set(c.endpointId, ep);
    }
    ep.calls.push(c.index);
    if (!ep.statuses.includes(c.status)) ep.statuses.push(c.status);
    for (const b of c.bindings) if (b.in === "path" && !ep.pathParams.includes(b.name)) ep.pathParams.push(b.name);
    for (const q of c.query) if (!ep.queryParams.includes(q.name)) ep.queryParams.push(q.name);
    if (c.body.kind === "json") {
      const s = inferShape(c.body.value);
      ep.requestShape = ep.requestShape ? mergeShapes(ep.requestShape, s) : s;
    } else if (c.body.kind === "form" || c.body.kind === "multipart") {
      ep.requestFields ??= [];
      for (const f of c.body.fields) if (!ep.requestFields.includes(f.name)) ep.requestFields.push(f.name);
    }
    ep.requestMime ??= c.requestMime;
    if (c.responseShape) ep.responseShape = ep.responseShape ? mergeShapes(ep.responseShape, c.responseShape) : c.responseShape;
    ep.responseMime ??= c.responseMime;
    // The sample is the best-scoring call; ties go to the latest (typeahead: last one is complete).
    if (c.score >= ep.score) {
      ep.score = c.score;
      ep.reasons = c.reasons;
      ep.sampleCall = c.index;
    }
  }
  const endpoints = [...byId.values()].sort((a, b) => b.score - a.score || a.sampleCall - b.sampleCall);

  if (!calls.length) warnings.push("No API-like requests survived filtering. Was the recording started before the workflow, with 'Preserve log' on?");
  const withBodies = calls.filter((c) => c.responsePreview).length;
  if (calls.length && withBodies === 0) {
    warnings.push("The HAR has no response bodies, so values cannot be traced to their source. Export with 'Save all as HAR with content'.");
  }
  for (const label of opts.inputs ?? []) {
    const used = calls.some((c) => c.bindings.some((b) => b.source.kind === "input" && b.source.label === label));
    if (!used) warnings.push(`The typed value "${label}" was not found in any request. It may be sent transformed (e.g. reformatted date) or not at all.`);
  }

  const selected = endpoints.length && endpoints[0].score > 0 ? [endpoints[0].id] : [];
  const artifacts: Report["artifacts"] = {};
  for (const ep of endpoints.slice(0, 60)) artifacts[ep.id] = buildArtifacts(calls[ep.sampleCall], calls);

  const times = entries.map((x) => x.t).filter(Boolean);
  return {
    meta: {
      generatedAt: new Date().toISOString(),
      entries: har.log.entries.length,
      kept: calls.length,
      dropped,
      hosts: [...hosts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h),
      durationSeconds: times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 1000) : 0,
    },
    workflow: { description: opts.description, inputs: opts.inputs ?? [] },
    intent,
    selected,
    endpoints,
    calls,
    auth: findAuth(calls),
    artifacts,
    openapi: buildOpenApi(endpoints, calls),
    llm: { used: false, primary: [], supporting: [], explanation: "", parameters: [], confidence: "low", caveats: [] },
    warnings,
  };
}

function findAuth(calls: Call[]): AuthFinding[] {
  const out = new Map<string, AuthFinding>();
  const bump = (type: AuthFinding["type"], name: string, detail: string) => {
    const key = `${type}:${name.toLowerCase()}`;
    const cur = out.get(key);
    if (!cur) return void out.set(key, { type, name, detail, usedBy: 1 });
    cur.usedBy++;
    // Prefer a detail that names a concrete origin over "not in the recording".
    if (/not in the recording|already set/.test(cur.detail) && / → /.test(detail)) cur.detail = detail;
  };
  for (const c of calls) {
    for (const b of c.bindings) {
      const from = describeSource(b.source, calls);
      if (b.in === "cookie" && /\{\{secret:/.test(b.value)) {
        bump("session-cookie", b.name, b.source.kind === "response" ? `set by ${from}` : "already set when the recording started (log in during the recording to capture its origin)");
      } else if (b.in === "header" && /^authorization$/i.test(b.name)) {
        const scheme = /^(\S+)\s/.exec(b.value)?.[1] ?? "token";
        bump(/basic/i.test(scheme) ? "basic" : "bearer", `Authorization: ${scheme}`, b.source.kind === "response" ? `token from ${from}` : "token origin not in the recording (often localStorage, or a login before recording started)");
      } else if (/csrf|xsrf|requestverificationtoken|authenticity/i.test(b.name) && b.in !== "cookie") {
        bump("csrf", `${b.name} (${b.in})`, b.source.kind === "response" ? `value from ${from}` : "origin not in the recording");
      } else if (b.in === "header" && /api[-_]?key|subscription-key/i.test(b.name)) {
        bump("api-key", b.name, b.source.kind === "response" ? `value from ${from}` : "static key, origin not in the recording");
      }
    }
    const fields = c.body.kind === "form" || c.body.kind === "multipart" ? c.body.fields.map((f) => f.name) : c.body.kind === "json" && c.body.value && typeof c.body.value === "object" ? Object.keys(c.body.value) : [];
    if (fields.some((f) => /pass(word|wd)?|pwd/i.test(f))) bump("login", c.endpointId, `credentials posted in fields: ${fields.join(", ")}`);
  }
  return [...out.values()].sort((a, b) => b.usedBy - a.usedBy);
}
