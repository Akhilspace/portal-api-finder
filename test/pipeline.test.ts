import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPortal } from "../demo/portal.ts";
import { analyze } from "../src/core/analyze.ts";
import { classify } from "../src/core/filter.ts";
import { parseHar, type Har, type HarEntry } from "../src/core/har.ts";
import { operationOf, parseRequestBody, templatePath } from "../src/core/normalize.ts";
import { parseAttrs, scrubHar } from "../src/core/scrub.ts";
import type { Report } from "../src/core/types.ts";
import { detectIntent } from "../src/core/rank.ts";

const raw: Har = parseHar(readFileSync(new URL("../fixtures/demo-portal.har", import.meta.url), "utf8"));
const INPUTS = [
  { label: "patient last name", value: "Zztest" },
  { label: "reason for visit", value: "Follow-up visit for knee pain" },
  { label: "note", value: "Copay collected at desk" },
];

const entry = (method: string, url: string, extra: Partial<HarEntry> = {}, body?: { mimeType: string; text: string }): HarEntry => ({
  startedDateTime: "2026-01-01T00:00:00Z",
  request: { method, url, headers: [], ...(body ? { postData: body } : {}) },
  response: { status: 200, headers: [], content: { mimeType: "application/json", text: "{}" } },
  ...extra,
});

describe("scrub", () => {
  const rawText = JSON.stringify(raw);
  const sid = /sid=([0-9a-f]{32})/.exec(rawText)![1];
  const csrf = /csrf-token\\" content=\\"([0-9a-f]{40})/.exec(rawText)![1];
  const { har, summary } = scrubHar(raw, INPUTS);
  const text = JSON.stringify(har);

  it("removes every occurrence of credentials and typed values", () => {
    expect(rawText).toContain(sid);
    expect(rawText).toContain("demo-pass-123");
    for (const secret of [sid, csrf, "demo-pass-123", "Zztest", "knee pain", "Copay collected"]) expect(text).not.toContain(secret);
  });

  it("replaces them with stable placeholders so values can still be followed", () => {
    expect(text).toContain("{{secret:sid}}");
    expect(text).toContain("{{secret:password}}");
    expect(text).toContain("{{input:patient_last_name}}");
    expect(summary.secrets.find((s) => s.token === "{{secret:sid}}")!.occurrences).toBeGreaterThan(10);
    expect(summary.bodiesDropped).toBeGreaterThan(0);
    expect(summary.bytesAfter).toBeLessThan(summary.bytesBefore);
  });

  it("is idempotent, so the server can safely scrub again", () => {
    expect(JSON.stringify(scrubHar(har, INPUTS).har)).toBe(text);
  });

  it("does not mutate its input", () => {
    expect(JSON.stringify(raw)).toBe(rawText);
  });

  it("keeps JSON bodies valid when a typed value is a bare number", () => {
    const h: Har = { log: { entries: [entry("POST", "https://p.test/api/pay", {}, { mimeType: "application/json", text: '{"amount":12550,"memo":"x"}' })] } };
    const out = scrubHar(h, [{ label: "amount", value: "12550" }]).har;
    expect(JSON.parse(out.log.entries[0].request.postData!.text!)).toEqual({ amount: "{{input:amount}}", memo: "x" });
  });

  it("does not treat ordinary words in token-ish fields as secrets", () => {
    const h: Har = {
      log: { entries: [entry("GET", "https://p.test/api/t", { response: { status: 200, headers: [], content: { mimeType: "application/json", text: '{"token_type":"Bearer","access_token":"abc123def456ghi789jkl012"}' } } })] },
    };
    const body = scrubHar(h).har.log.entries[0].response.content!.text!;
    expect(JSON.parse(body)).toEqual({ token_type: "Bearer", access_token: "{{secret:access_token}}" });
  });

  it("parses html attributes in any quoting style", () => {
    expect(parseAttrs(`<input type=hidden name='a' value="b c">`)).toEqual({ type: "hidden", name: "a", value: "b c" });
  });
});

describe("filter and normalize", () => {
  it("drops assets, trackers and preflights but keeps form posts and page loads", () => {
    expect(classify(entry("GET", "https://p.test/static/app.js", { _resourceType: "script" })).keep).toBe(false);
    expect(classify(entry("GET", "https://p.test/logo.png")).keep).toBe(false);
    expect(classify(entry("OPTIONS", "https://p.test/api/x")).keep).toBe(false);
    expect(classify(entry("POST", "https://www.google-analytics.com/g/collect")).keep).toBe(false);
    expect(classify(entry("POST", "https://p.test/save.php", { _resourceType: "document" }))).toMatchObject({ keep: true, kind: "document" });
    expect(classify(entry("GET", "https://p.test/api/patients", { _resourceType: "fetch" }))).toMatchObject({ keep: true, kind: "api" });
  });

  it("templates ids in paths and names them after the collection", () => {
    expect(templatePath("/api/patients/10482/appointments/7f3c1e9a-2b1d-4c5e-9f00-112233445566").template).toBe("/api/patients/{patientId}/appointments/{appointmentId}");
    expect(templatePath("/api/v2/providers").template).toBe("/api/v2/providers");
    expect(templatePath("/interface/main/calendar/add_edit_event.php").template).toBe("/interface/main/calendar/add_edit_event.php");
    expect(templatePath("/charts/MRN-553201").template).toBe("/charts/{chartId}");
  });

  it("splits multiplexed endpoints by operation", () => {
    const gql = entry("POST", "https://p.test/graphql", {}, { mimeType: "application/json", text: '{"operationName":"BookAppointment","query":"mutation BookAppointment($i: In!) { book(input: $i) { id } }"}' });
    expect(operationOf(gql, parseRequestBody(gql), "/graphql")).toBe("graphql BookAppointment");
    const php = entry("POST", "https://p.test/ajax.php?action=save_encounter", {}, { mimeType: "application/x-www-form-urlencoded", text: "pid=4" });
    php.request.queryString = [{ name: "action", value: "save_encounter" }];
    expect(operationOf(php, parseRequestBody(php), "/ajax.php")).toBe("action=save_encounter");
  });
});

describe("analysis of the demo portal recording", () => {
  const { har } = scrubHar(raw, INPUTS);
  const report = analyze(har, { description: "Search for a patient and book an appointment with a provider", inputs: ["patient_last_name", "reason_for_visit"] });
  const top = report.endpoints[0];
  const sample = report.calls[top.sampleCall];
  const origin = (name: string) => report.artifacts[top.id].variables.find((v) => v.name === name)?.from;

  it("filters the noise", () => {
    expect(report.meta.entries).toBe(raw.log.entries.length);
    expect(report.meta.dropped["static asset"]).toBeGreaterThan(5);
    expect(report.endpoints.some((e) => e.pathTemplate.startsWith("/static"))).toBe(false);
  });

  it("ranks the booking call first and telemetry and polling last", () => {
    expect(top.id).toBe("POST localhost:4000/api/appointments");
    expect(report.selected).toEqual([top.id]);
    const rank = (path: string) => report.endpoints.findIndex((e) => e.pathTemplate === path);
    expect(rank("/api/notifications/unread-count")).toBe(report.endpoints.length - 1);
    expect(rank("/api/telemetry")).toBeGreaterThan(rank("/api/providers/{providerId}/slots"));
  });

  it("traces every dynamic value of the booking call to where it came from", () => {
    expect(origin("csrfToken")).toBe('GET /dashboard → <meta name="csrf-token">');
    expect(origin("patientId")).toBe("GET /api/patients → $.results[0].id");
    expect(origin("providerId")).toBe("GET /api/providers → $.providers[1].id");
    expect(origin("slotId")).toBe("GET /api/providers/{providerId}/slots → $.slots[1].slotId");
    expect(origin("sid")).toBe("POST /login → Set-Cookie sid");
    expect(origin("reasonForVisit")).toContain("typed by the recorder");
    // constants are not turned into variables
    expect(sample.bindings.some((b) => b.name === "$.visitType")).toBe(false);
  });

  it("explains authentication", () => {
    const types = report.auth.map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(["session-cookie", "csrf", "login"]));
    expect(report.auth.find((a) => a.type === "session-cookie")!.detail).toContain("POST /login");
  });

  it("generates code with named variables and no secrets", () => {
    const art = report.artifacts[top.id];
    expect(art.curl).toContain('-H "X-CSRF-Token: ${CSRF_TOKEN}"');
    expect(art.curl).toContain('"patientId": ${PATIENT_ID},');
    expect(art.typescript).toContain("patientId: number;");
    expect(art.typescript).toContain("reason: v.reasonForVisit,");
    expect(art.verify).toContain("const SEND = false;");
    expect(JSON.stringify(report)).not.toMatch(/[0-9a-f]{32}/); // no raw session id or csrf token anywhere
  });

  it("produces an OpenAPI document", () => {
    const paths = (report.openapi as { paths: Record<string, Record<string, { requestBody?: unknown }>> }).paths;
    expect(paths["/api/appointments"].post.requestBody).toBeTruthy();
    expect(paths["/api/providers/{providerId}/slots"].get).toBeTruthy();
  });

  it("handles the legacy form-post workflow in the same recording", () => {
    const r = analyze(har, { description: "Add a billing charge for a patient", inputs: ["note"] });
    expect(r.endpoints[0].id).toBe("POST localhost:4000/legacy/billing/save.php [action=save]");
    const vars = r.artifacts[r.endpoints[0].id].variables;
    expect(vars.find((v) => v.name === "csrfTokenForm")!.from).toBe('GET /legacy/billing/new.php → <input name="csrf_token_form">');
    expect(vars.find((v) => v.name === "formPid")!.from).toBe("GET /api/patients → $.results[0].id");
  });

  it("uses the complete typeahead request, not a partial one, as the patient search sample", () => {
    const search = report.endpoints.find((e) => e.pathTemplate === "/api/patients")!;
    expect(search.calls.length).toBeGreaterThan(1);
    expect(report.calls[search.sampleCall].query.find((q) => q.name === "query")!.value).toBe("{{input:patient_last_name}}");
  });

  it("warns when a typed value never shows up in a request", () => {
    const r = analyze(har, { description: "book an appointment", inputs: ["date_of_birth"] });
    expect(r.warnings.join(" ")).toContain("date_of_birth");
  });
});

// The strongest check: run the generated verification snippet, unmodified apart from the
// inputs, against a live portal with a brand-new session, the way a clinic employee would.
describe("generated verify snippet against a live portal", () => {
  let server: ReturnType<ReturnType<typeof createPortal>["listen"]>;
  let base = "";
  const jar = new Map<string, string>();
  const realFetch = globalThis.fetch;
  const g = globalThis as Record<string, unknown>;

  beforeAll(async () => {
    server = createPortal().listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    // A stand-in for the browser: cookie jar, DOMParser, storage.
    g.fetch = async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (jar.size) headers.set("Cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
      const res = await realFetch(url, { ...init, headers, redirect: "manual" });
      for (const c of res.headers.getSetCookie()) jar.set(c.split("=")[0], c.split(";")[0].split("=").slice(1).join("="));
      return res;
    };
    g.document = { cookie: "", querySelector: () => null };
    g.localStorage = g.sessionStorage = { length: 0, key: () => null, getItem: () => null };
    g.DOMParser = class {
      parseFromString(html: string) {
        return {
          querySelector(sel: string) {
            const name = /\[name="([^"]+)"\]/.exec(sel)![1];
            const tag = (html.match(/<(meta|input)\b[^>]*>/g) ?? []).find((t) => parseAttrs(t).name === name);
            return tag ? { getAttribute: (a: string) => parseAttrs(tag)[a] } : null;
          },
        };
      }
    };
    await (g.fetch as typeof fetch)(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "username=demo&password=demo-pass-123" });
  });
  afterAll(() => {
    g.fetch = realFetch;
    server.close();
  });

  const run = async (report: Report, inputs: Record<string, string>, send: boolean) => {
    let code = report.artifacts[report.selected[0]].verify.replaceAll("http://localhost:4000", base);
    if (send) code = code.replace("const SEND = false;", "const SEND = true;");
    for (const [k, v] of Object.entries(inputs)) code = code.replace(`${k}: "CHANGE_ME"`, `${k}: ${JSON.stringify(v)}`);
    const logs: unknown[][] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void logs.push(a);
    try {
      await (0, eval)(code.trim().replace(/;$/, ""));
    } finally {
      console.log = realLog;
    }
    return JSON.parse(logs.map((l) => l[0]).filter((x): x is string => typeof x === "string" && x.trim().startsWith("{")).pop()!);
  };

  it("books an appointment by replaying the dependency chain", async () => {
    const { har } = scrubHar(raw, INPUTS);
    const report = analyze(har, { description: "Search for a patient and book an appointment", inputs: ["patient_last_name", "reason_for_visit"] });
    const dry = await run(report, { patientLastName: "Zztest", reasonForVisit: "Annual physical" }, false);
    expect(dry.sent).toBe(false);
    expect(dry.steps).toMatchObject({ csrfToken: "ok", patientId: "ok", providerId: "ok", slotId: "ok" });

    const real = await run(report, { patientLastName: "Zztest", reasonForVisit: "Annual physical" }, true);
    expect(real).toMatchObject({ sent: true, status: 201 });
    expect(real.shape.appointment).toMatchObject({ id: "string", status: "string" }); // structure only, no values
  });

  it("submits the legacy billing form, hidden fields included", async () => {
    const { har } = scrubHar(raw, INPUTS);
    const report = analyze(har, { description: "Add a billing charge for a patient", inputs: ["patient_last_name", "note"] });
    const real = await run(report, { patientLastName: "Zztest", note: "Paid in cash" }, true);
    expect(real.sent).toBe(true);
    expect(real.steps).toMatchObject({ csrfTokenForm: "ok", formPid: "ok", formEncounter: "ok" });
    expect([200, 302]).toContain(real.status);
  });
});

// Same portal, but recorded by a real Chrome clicking through the UI (typeahead requests,
// browser-shaped headers and cookies) rather than by the scripted recorder.
describe("a HAR captured by real Chrome", () => {
  const chrome = parseHar(readFileSync(new URL("../fixtures/demo-portal-chrome.har", import.meta.url), "utf8"));
  const { har } = scrubHar(chrome, INPUTS);
  const report = analyze(har, { description: "Search for a patient and book an appointment with a provider", inputs: ["patient_last_name", "reason_for_visit"] });

  it("finds the same call with the same provenance", () => {
    expect(report.endpoints[0].id).toBe("POST localhost:4000/api/appointments");
    const vars = Object.fromEntries(report.artifacts[report.endpoints[0].id].variables.map((v) => [v.name, v.from]));
    expect(vars.csrfToken).toBe('GET /dashboard → <meta name="csrf-token">');
    expect(vars.patientId).toBe("GET /api/patients → $.results[0].id");
    expect(vars.slotId).toMatch(/^GET \/api\/providers\/\{providerId\}\/slots → \$\.slots\[\d\]\.slotId$/);
    expect(vars.sid).toBe("POST /login → Set-Cookie sid");
  });
});

describe("workflow intent", () => {
  it("does not treat 'sign in' as a write", () => {
    expect(detectIntent("Sign in, search for a patient by name, open their chart.")).toBe("read");
  });
  it("still treats booking as a write", () => {
    expect(detectIntent("Book an appointment for an existing patient.")).toBe("write");
  });
});