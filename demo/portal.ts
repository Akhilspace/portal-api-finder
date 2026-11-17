// "Lakeside Clinic" - a small fake clinic portal to record against. Fictional data only.
// It deliberately behaves like the portals this tool targets:
//   - cookie session + CSRF token in a <meta> tag, sent back as a header (modern SPA style)
//   - a JSON API behind the UI, with ids that flow from one call into the next
//   - a server-rendered legacy module: hidden form fields, form POST, 302 redirect
//   - noise: static assets, telemetry beacons, polling
//
//   npm run demo:portal        ->  http://localhost:4000   (login: demo / demo-pass-123)

import express from "express";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const hex = (n: number) => randomBytes(n).toString("hex");

const PATIENTS = [
  { id: 10482, firstName: "Avery", lastName: "Zztest", dob: "1984-03-12", mrn: "MRN-553201" },
  { id: 10977, firstName: "Jordan", lastName: "Zztest", dob: "1991-11-02", mrn: "MRN-553877" },
  { id: 11204, firstName: "Sam", lastName: "Demo", dob: "1975-07-30", mrn: "MRN-554010" },
  { id: 11391, firstName: "Riley", lastName: "Sample", dob: "2001-01-19", mrn: "MRN-554422" },
];
const PROVIDERS = [
  { id: 2001, name: "Dr. Imani Okafor", specialty: "Family Medicine" },
  { id: 2002, name: "Dr. Luis Herrera", specialty: "Pediatrics" },
];

const page = (title: string, body: string, head = "") => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title} - Lakeside Clinic</title>
<link rel="stylesheet" href="/static/style.css">${head}</head>
<body><header><img src="/static/logo.svg" alt="" width="28" height="28"><b>Lakeside Clinic Portal</b>
<nav><a href="/dashboard">Scheduling</a></nav></header>
<main>${body}</main></body></html>`;

const APP_JS = `
const csrf = document.querySelector('meta[name="csrf-token"]').content;
const $ = (id) => document.getElementById(id);
const api = (url, opts = {}) => fetch(url, { ...opts, headers: { "X-Requested-With": "XMLHttpRequest", ...(opts.headers || {}) } }).then((r) => r.json());
const beacon = (event) => fetch("/api/telemetry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, ts: Date.now(), path: location.pathname }) });
let patient = null, slot = null, timer = null;
api("/api/me").then((me) => ($("who").textContent = me.displayName));
api("/api/providers").then((d) => { $("provider").innerHTML = d.providers.map((p) => '<option value="' + p.id + '">' + p.name + "</option>").join(""); loadSlots(); });
setInterval(() => api("/api/notifications/unread-count").then((d) => ($("unread").textContent = d.unread)), 3000);
$("q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 250); });
async function search() {
  const q = $("q").value.trim(); if (q.length < 2) return;
  const d = await api("/api/patients?query=" + encodeURIComponent(q) + "&limit=10");
  $("results").innerHTML = d.results.map((p) => '<li data-id="' + p.id + '">' + p.lastName + ", " + p.firstName + " (" + p.mrn + ")</li>").join("") || "<li>No match</li>";
}
$("results").addEventListener("click", (e) => { const li = e.target.closest("li[data-id]"); if (!li) return; patient = Number(li.dataset.id); $("picked").textContent = li.textContent; $("charge").innerHTML = ' <a href="/legacy/billing/new.php?pid=' + patient + '">Add a billing charge (legacy module)</a>'; beacon("patient_selected"); });
$("provider").addEventListener("change", loadSlots); $("date").addEventListener("change", loadSlots);
async function loadSlots() {
  const d = await api("/api/providers/" + $("provider").value + "/slots?date=" + $("date").value);
  $("slots").innerHTML = d.slots.map((s) => '<button type="button" data-slot="' + s.slotId + '">' + s.start.slice(11, 16) + "</button>").join("");
}
$("slots").addEventListener("click", (e) => { if (!e.target.dataset.slot) return; slot = e.target.dataset.slot; [...$("slots").children].forEach((b) => b.classList.toggle("on", b === e.target)); });
$("book").addEventListener("click", async () => {
  if (!patient || !slot) return ($("msg").textContent = "Pick a patient and a time first.");
  beacon("book_clicked");
  const d = await api("/api/appointments", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ patientId: patient, providerId: Number($("provider").value), slotId: slot, reason: $("reason").value, visitType: "office", notifyPatient: true }) });
  $("msg").textContent = d.appointment ? "Booked. Confirmation " + d.appointment.id : "Error: " + d.error;
});
`;

const STYLE = `body{font:15px system-ui;margin:0;color:#1d2733}header{display:flex;gap:12px;align-items:center;padding:10px 20px;background:#0f4c5c;color:#fff}
header a{color:#cfe8ee;margin-left:14px}main{max-width:760px;margin:24px auto;padding:0 20px}input,select,textarea,button{font:inherit;padding:6px 8px;margin:4px 0}
li[data-id]{cursor:pointer;padding:4px}li[data-id]:hover{background:#eef6f8}#slots button{margin-right:6px}#slots .on{background:#0f4c5c;color:#fff}
fieldset{margin:16px 0;border:1px solid #ccd6dd;border-radius:6px}.muted{color:#667}`;

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#e36414"/><path d="M14 8h4v6h6v4h-6v6h-4v-6H8v-4h6z" fill="#fff"/></svg>`;

export function createPortal() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const sessions = new Map<string, { user: string; csrf: string }>();
  const appointments: Record<string, unknown>[] = [];
  const charges = new Map<number, Record<string, string>>();
  let nextCharge = 77120;

  const sessionOf = (req: express.Request) => {
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    return sid ? sessions.get(sid) : undefined;
  };
  const requireSession: express.RequestHandler = (req, res, next) => {
    const s = sessionOf(req);
    if (s) {
      res.locals.session = s;
      return next();
    }
    if (req.path.startsWith("/api/")) return void res.status(401).json({ error: "not logged in" });
    res.redirect("/login");
  };

  app.get("/static/app.js", (_q, res) => void res.type("application/javascript").send(APP_JS));
  app.get("/static/style.css", (_q, res) => void res.type("text/css").send(STYLE));
  app.get("/static/logo.svg", (_q, res) => void res.type("image/svg+xml").send(LOGO));

  app.get("/", (_q, res) => res.redirect("/dashboard"));
  app.get("/login", (_q, res) => {
    res.send(
      page(
        "Sign in",
        `<h2>Sign in</h2><p class="muted">Demo account: <code>demo</code> / <code>demo-pass-123</code></p>
<form method="post" action="/login"><input name="username" placeholder="Username" value="demo"><br>
<input name="password" type="password" placeholder="Password" value="demo-pass-123"><br><button>Sign in</button></form>`,
      ),
    );
  });
  app.post("/login", (req, res) => {
    if (req.body.username !== "demo" || req.body.password !== "demo-pass-123") return void res.status(401).send(page("Sign in", "<p>Wrong credentials.</p>"));
    const sid = hex(16);
    sessions.set(sid, { user: "demo", csrf: hex(20) });
    res.setHeader("Set-Cookie", [`sid=${sid}; Path=/; HttpOnly; SameSite=Lax`, "ui_theme=light; Path=/"]);
    res.redirect("/dashboard");
  });

  app.get("/dashboard", requireSession, (_q, res) => {
    const today = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    res.send(
      page(
        "Scheduling",
        `<p class="muted">Signed in as <span id="who">…</span> · <span id="unread">0</span> unread</p>
<h2>Book an appointment</h2>
<fieldset><legend>1. Patient</legend><input id="q" placeholder="Search last name or MRN" autocomplete="off">
<ul id="results"></ul><div>Selected: <b id="picked">none</b><span id="charge"></span></div></fieldset>
<fieldset><legend>2. Provider and time</legend><select id="provider"></select> <input id="date" type="date" value="${today}"><div id="slots"></div></fieldset>
<fieldset><legend>3. Details</legend><textarea id="reason" rows="2" cols="50" placeholder="Reason for visit"></textarea></fieldset>
<button id="book">Book appointment</button> <span id="msg"></span>
<script src="/static/app.js"></script>`,
        `<meta name="csrf-token" content="${res.locals.session.csrf}">`,
      ),
    );
  });

  app.get("/api/me", requireSession, (_q, res) => void res.json({ id: 31, username: "demo", displayName: "Demo Scheduler", roles: ["scheduler"] }));
  app.get("/api/notifications/unread-count", requireSession, (_q, res) => void res.json({ unread: 0 }));
  app.post("/api/telemetry", (_q, res) => void res.status(204).end());
  app.get("/api/patients", requireSession, (req, res) => {
    const q = String(req.query.query ?? "").toLowerCase();
    const results = PATIENTS.filter((p) => `${p.lastName} ${p.firstName} ${p.mrn}`.toLowerCase().includes(q));
    res.json({ results, total: results.length, query: req.query.query });
  });
  app.get("/api/providers", requireSession, (_q, res) => void res.json({ providers: PROVIDERS }));
  app.get("/api/providers/:id/slots", requireSession, (req, res) => {
    const date = String(req.query.date ?? "").replace(/[^0-9-]/g, "");
    const slots = ["09:00", "09:30", "10:30", "14:00"].map((t) => ({
      slotId: `slot-${date.replace(/-/g, "")}-${t.replace(":", "")}-${req.params.id}`,
      start: `${date}T${t}:00-06:00`,
      durationMinutes: 30,
      available: true,
    }));
    res.json({ providerId: Number(req.params.id), date, slots });
  });
  app.post("/api/appointments", requireSession, (req, res) => {
    if (req.headers["x-csrf-token"] !== res.locals.session.csrf) return void res.status(403).json({ error: "bad csrf token" });
    const { patientId, providerId, slotId } = req.body ?? {};
    if (!PATIENTS.some((p) => p.id === patientId) || !slotId) return void res.status(422).json({ error: "patientId and slotId are required" });
    const appointment = { id: `apt_${hex(4)}`, status: "booked", patientId, providerId, slotId, reason: req.body.reason ?? "", createdAt: new Date().toISOString() };
    appointments.push(appointment);
    res.status(201).json({ appointment });
  });

  // ----- legacy, server-rendered billing module -----
  app.get("/legacy/billing/new.php", requireSession, (req, res) => {
    const pid = String(req.query.pid ?? "").replace(/\D/g, "");
    res.send(
      page(
        "New charge",
        `<h2>New charge for patient #${pid}</h2>
<form method="post" action="/legacy/billing/save.php?action=save">
<input type="hidden" name="csrf_token_form" value="${res.locals.session.csrf}">
<input type="hidden" name="form_pid" value="${pid}"><input type="hidden" name="form_encounter" value="903381">
CPT code <input name="form_code" value="99213"><br>Amount <input name="form_fee" value="125.00"><br>
Note <input name="form_note" size="40"><br><button name="form_save" value="Save">Save charge</button></form>`,
      ),
    );
  });
  app.post("/legacy/billing/save.php", requireSession, (req, res) => {
    if (req.body.csrf_token_form !== res.locals.session.csrf) return void res.status(403).send("CSRF check failed");
    const id = nextCharge++;
    charges.set(id, req.body);
    res.redirect(`/legacy/billing/view.php?charge_id=${id}`);
  });
  app.get("/legacy/billing/view.php", requireSession, (req, res) => {
    const c = charges.get(Number(req.query.charge_id));
    res.send(page("Charge", c ? `<h2>Charge #${req.query.charge_id} saved</h2><p>CPT ${c.form_code}, $${c.form_fee}. ${c.form_note ?? ""}</p>` : "<p>Not found</p>"));
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.DEMO_PORT ?? 4000);
  createPortal().listen(port, () => console.log(`Demo portal on http://localhost:${port}  (login: demo / demo-pass-123)`));
}
