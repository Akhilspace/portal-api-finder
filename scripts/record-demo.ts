// Drives the demo portal the way a browser would and writes a raw (unscrubbed) HAR.
// It exists so the fixture is reproducible and tests need no browser:
//
//   npm run demo:record      ->  fixtures/demo-portal.har
//
// For a real demonstration, record with actual DevTools instead (see README).

import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createPortal } from "../demo/portal.ts";
import type { HarEntry } from "../src/core/har.ts";

const TYPED = { lastName: "Zztest", reason: "Follow-up visit for knee pain", note: "Copay collected at desk" };

const port = Number(process.env.DEMO_PORT ?? 4000);
const server = createPortal().listen(port);
await new Promise((r) => server.once("listening", r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

const entries: HarEntry[] = [];
const jar = new Map<string, string>();
let clock = Date.parse("2026-11-16T15:00:00.000Z");

async function hit(method: string, path: string, type: string, opts: { headers?: Record<string, string>; body?: string; mime?: string } = {}) {
  clock += 400 + Math.floor(Math.random() * 900);
  const url = base + path;
  const headers: Record<string, string> = {
    Accept: type === "document" ? "text/html" : "*/*",
    "User-Agent": "Mozilla/5.0 (demo recorder)",
    ...(opts.mime ? { "Content-Type": opts.mime } : {}),
    ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
    ...opts.headers,
  };
  const sentCookies = [...jar].map(([name, value]) => ({ name, value }));
  const res = await fetch(url, { method, headers, body: opts.body, redirect: "manual" });
  const text = await res.text();
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    jar.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
  }
  const u = new URL(url);
  const resHeaders = [...res.headers].filter(([k]) => k !== "set-cookie").map(([name, value]) => ({ name, value }));
  for (const c of res.headers.getSetCookie()) resHeaders.push({ name: "set-cookie", value: c });
  entries.push({
    startedDateTime: new Date(clock).toISOString(),
    time: 35,
    _resourceType: type,
    request: {
      method,
      url,
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      queryString: [...u.searchParams].map(([name, value]) => ({ name, value })),
      cookies: sentCookies,
      ...(opts.body !== undefined ? { postData: { mimeType: opts.mime ?? "text/plain", text: opts.body } } : {}),
    },
    response: {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
      content: { size: text.length, mimeType: res.headers.get("content-type") ?? "", text },
      redirectURL: res.headers.get("location") ?? "",
    },
  });
  return { res, text, json: () => JSON.parse(text) };
}

const xhr = { "X-Requested-With": "XMLHttpRequest" };
const assets = async () => {
  await hit("GET", "/static/style.css", "stylesheet");
  await hit("GET", "/static/logo.svg", "image");
};
const beacon = (event: string) => hit("POST", "/api/telemetry", "fetch", { mime: "application/json", body: JSON.stringify({ event, ts: clock, path: "/dashboard" }) });
const poll = () => hit("GET", "/api/notifications/unread-count", "fetch", { headers: xhr });

// --- sign in ---
await hit("GET", "/login", "document");
await assets();
await hit("POST", "/login", "document", { mime: "application/x-www-form-urlencoded", body: "username=demo&password=demo-pass-123" });

// --- workflow 1: book an appointment (modern JSON API) ---
const dash = await hit("GET", "/dashboard", "document");
await assets();
await hit("GET", "/static/app.js", "script");
const csrf = /name="csrf-token" content="([^"]+)"/.exec(dash.text)![1];
await hit("GET", "/api/me", "fetch", { headers: xhr });
const providers = (await hit("GET", "/api/providers", "fetch", { headers: xhr })).json().providers;
await hit("GET", `/api/providers/${providers[0].id}/slots?date=2026-11-20`, "fetch", { headers: xhr });
await poll();
await hit("GET", `/api/patients?query=Zzt&limit=10`, "fetch", { headers: xhr }); // typeahead, partial
const found = (await hit("GET", `/api/patients?query=${TYPED.lastName}&limit=10`, "fetch", { headers: xhr })).json();
await beacon("patient_selected");
await poll();
const slots = (await hit("GET", `/api/providers/${providers[1].id}/slots?date=2026-11-20`, "fetch", { headers: xhr })).json().slots;
await poll();
await beacon("book_clicked");
await hit("POST", "/api/appointments", "fetch", {
  headers: { ...xhr, "X-CSRF-Token": csrf },
  mime: "application/json",
  body: JSON.stringify({ patientId: found.results[0].id, providerId: providers[1].id, slotId: slots[1].slotId, reason: TYPED.reason, visitType: "office", notifyPatient: true }),
});
await poll();
await poll();

// --- workflow 2: add a billing charge (legacy form post) ---
const form = await hit("GET", `/legacy/billing/new.php?pid=${found.results[0].id}`, "document");
await assets();
const hidden = (name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(form.text)![1];
const save = await hit("POST", "/legacy/billing/save.php?action=save", "document", {
  mime: "application/x-www-form-urlencoded",
  body: new URLSearchParams({
    csrf_token_form: hidden("csrf_token_form"),
    form_pid: hidden("form_pid"),
    form_encounter: hidden("form_encounter"),
    form_code: "99213",
    form_fee: "125.00",
    form_note: TYPED.note,
    form_save: "Save",
  }).toString(),
});
await hit("GET", save.res.headers.get("location")!, "document");
await assets();

const out = new URL("../fixtures/demo-portal.har", import.meta.url);
writeFileSync(out, JSON.stringify({ log: { version: "1.2", creator: { name: "record-demo", version: "1" }, entries } }, null, 1));
console.log(`Wrote ${entries.length} entries to ${out.pathname}`);
server.close();
