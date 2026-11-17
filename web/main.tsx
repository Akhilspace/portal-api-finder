import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { parseHar, type Har } from "../src/core/har.ts";
import { scrubHar, type ScrubSummary } from "../src/core/scrub.ts";
import { summarizeShape } from "../src/core/shape.ts";
import type { Endpoint, Report } from "../src/core/types.ts";

interface CaptureSummary {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  uploadedAt?: string;
  selected: string[];
  verifications: number;
}
interface Capture {
  id: string;
  title: string;
  description: string;
  inputLabels: string[];
  createdAt: string;
  uploadedAt?: string;
  scrub?: ScrubSummary;
  verifications: { receivedAt: string; result: Record<string, unknown> }[];
  report?: Report;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

const kb = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "");
const short = (ep: { method: string; pathTemplate: string; operation?: string }) => `${ep.pathTemplate}${ep.operation ? ` [${ep.operation}]` : ""}`;

function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function App() {
  const hash = useHash();
  const [health, setHealth] = useState<{ llm: boolean; model: string } | null>(null);
  useEffect(() => void api<{ llm: boolean; model: string }>("/api/health").then(setHealth).catch(() => {}), []);
  const m = /^#\/(c|r)\/([0-9a-f-]{36})/.exec(hash);
  const recorder = m?.[1] === "c";
  return (
    <>
      <header className="top">
        <a className="brand" href={recorder ? location.hash : "#/"}>
          Portal API Finder
        </a>
        <span className="spacer" />
        {!recorder && health && <span className={`pill ${health.llm ? "on" : "warn"}`}>{health.llm ? `LLM: ${health.model}` : "LLM off: heuristics only"}</span>}
      </header>
      <main>{m ? recorder ? <Recorder id={m[2]} /> : <ReportPage id={m[2]} /> : <Home />}</main>
    </>
  );
}

// ---------- engineer: capture requests ----------

function Home() {
  const [list, setList] = useState<CaptureSummary[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState("");
  const [error, setError] = useState("");
  const refresh = () => api<CaptureSummary[]>("/api/captures").then(setList).catch((e) => setError(e.message));
  useEffect(() => void refresh(), []);

  const create = async () => {
    setError("");
    try {
      const inputLabels = labels.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      await api("/api/captures", { title, description, inputLabels });
      setTitle("");
      setDescription("");
      setLabels("");
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const link = (id: string) => `${location.origin}/#/c/${id}`;

  return (
    <>
      <h1>Find the API call behind a portal workflow</h1>
      <p className="muted">
        Describe a workflow, send the capture link to someone at the clinic, and get back the internal request that performs it: where every value comes from, a
        curl command, a typed client, and a snippet to verify it from inside their network.
      </p>

      <div className="card">
        <h2>New capture request</h2>
        <label>Workflow</label>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Book an appointment for an existing patient" />
        <label>
          Steps for the person recording <span className="muted">(shown to them; also used to rank requests)</span>
        </label>
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Search for the test patient, pick a provider and a time slot, enter a reason, click Book." />
        <label>
          Values they will type <span className="muted">(comma separated; they tell us what they typed, and we find where it lands)</span>
        </label>
        <input type="text" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="patient last name, reason for visit" />
        <div className="row" style={{ marginTop: 14 }}>
          <button className="primary" disabled={!title.trim()} onClick={create}>
            Create capture link
          </button>
          {error && <span style={{ color: "var(--bad)" }}>{error}</span>}
        </div>
      </div>

      <div className="card">
        <h2>Capture requests</h2>
        {!list.length && <p className="muted">None yet.</p>}
        {!!list.length && (
          <table>
            <thead>
              <tr>
                <th>Workflow</th>
                <th>Status</th>
                <th>Result</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td>
                    <b>{c.title}</b>
                    <div className="muted small">{when(c.createdAt)}</div>
                  </td>
                  <td>{c.uploadedAt ? <span className="pill on">recording received</span> : <span className="pill warn">waiting for recording</span>}</td>
                  <td className="mono">{c.selected.map((s) => s.replace(/ [^/ ]+\//, " /")).join(", ") || "-"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <CopyButton text={link(c.id)} label="Copy capture link" /> <a href={`#/c/${c.id}`}>open</a>
                    {c.uploadedAt && (
                      <>
                        {" · "}
                        <a href={`#/r/${c.id}`}>
                          <b>report</b>
                        </a>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

// ---------- clinic side: record, scrub locally, upload ----------

function Recorder({ id }: { id: string }) {
  const [info, setInfo] = useState<{ title: string; description: string; inputLabels: string[]; uploaded: boolean } | null>(null);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState<{ name: string; har: Har } | null>(null);
  const [scrubbed, setScrubbed] = useState<{ har: Har; summary: ScrubSummary } | null>(null);
  const [over, setOver] = useState(false);
  const [state, setState] = useState<"idle" | "uploading" | "done">("idle");
  const [verify, setVerify] = useState("");
  const [verifyMsg, setVerifyMsg] = useState("");

  useEffect(() => void api<typeof info>(`/api/captures/${id}/public`).then(setInfo).catch((e) => setError(e.message)), [id]);

  // Scrubbing happens here, in this browser tab. Re-run whenever the typed values change.
  useEffect(() => {
    if (!raw || !info) return;
    try {
      setScrubbed(scrubHar(raw.har, info.inputLabels.map((label) => ({ label, value: typed[label] ?? "" }))));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [raw, typed, info]);

  const onFile = async (file?: File) => {
    if (!file) return;
    setError("");
    try {
      setRaw({ name: file.name, har: parseHar(await file.text()) });
    } catch (e) {
      setRaw(null);
      setScrubbed(null);
      setError((e as Error).message);
    }
  };
  const upload = async () => {
    if (!scrubbed) return;
    setState("uploading");
    try {
      await api(`/api/captures/${id}/har`, { har: scrubbed.har, summary: scrubbed.summary });
      setState("done");
    } catch (e) {
      setError((e as Error).message);
      setState("idle");
    }
  };
  const sendVerify = async () => {
    try {
      await api(`/api/captures/${id}/verifications`, { result: verify });
      setVerify("");
      setVerifyMsg("Sent. Thank you.");
    } catch (e) {
      setVerifyMsg((e as Error).message);
    }
  };

  if (!info) return <p className={error ? "" : "muted"}>{error || "Loading…"}</p>;
  return (
    <>
      <h1>Record: {info.title}</h1>
      <p className="muted">
        This takes about three minutes and uses only your normal browser. Nothing is installed. Passwords, session cookies and tokens are removed on this page,
        on your computer, before anything is sent.
      </p>

      <div className="card">
        <h2>1. Record the workflow</h2>
        <ol className="steps">
          <li>
            Open the portal in Chrome or Edge. Press <kbd>F12</kbd> (or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd>) and choose the <b>Network</b> tab.
          </li>
          <li>
            Tick <b>Preserve log</b>. If you can, sign in to the portal now, so the sign-in is part of the recording.
          </li>
          <li>
            Do this, using a <b>test patient</b> if one exists: <b>{info.description || info.title}</b>
          </li>
          <li>
            In the Network tab click the download arrow (<b>Export HAR…</b>). If asked, choose <b>with sensitive data</b>: the sensitive parts are removed in
            step 3, and without them the recording is much less useful.
          </li>
        </ol>
        <p className="muted small">Firefox: Network tab → gear icon → Persist Logs, then Save All As HAR.</p>
      </div>

      {!!info.inputLabels.length && (
        <div className="card">
          <h2>2. What did you type?</h2>
          <p className="muted">Exactly as typed. These values are used on this page to find where they went, and are replaced by their labels before upload.</p>
          {info.inputLabels.map((label) => (
            <div key={label}>
              <label>{label}</label>
              <input type="text" value={typed[label] ?? ""} onChange={(e) => setTyped({ ...typed, [label]: e.target.value })} />
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>{info.inputLabels.length ? "3" : "2"}. Add the HAR file</h2>
        <div
          className={`drop ${over ? "over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            onFile(e.dataTransfer.files[0]);
          }}
        >
          <p>{raw ? <b>{raw.name}</b> : "Drop the .har file here"}</p>
          <input type="file" accept=".har,application/json" onChange={(e) => onFile(e.target.files?.[0])} />
        </div>
        {error && <div className="note">{error}</div>}
        {scrubbed && state !== "done" && (
          <>
            <div className="note ok">
              <b>Nothing has been sent yet.</b> Checked {scrubbed.har.log.entries.length} requests on this computer: removed{" "}
              <b>{scrubbed.summary.secrets.length}</b> passwords, cookies and tokens, labelled <b>{scrubbed.summary.inputs.filter((i) => i.occurrences).length}</b>{" "}
              typed values, dropped {scrubbed.summary.bodiesDropped} images and scripts. Size {kb(scrubbed.summary.bytesBefore)} → {kb(scrubbed.summary.bytesAfter)}.
            </div>
            {scrubbed.summary.inputs.some((i) => !i.occurrences) && (
              <div className="note">
                Not found in the recording: {scrubbed.summary.inputs.filter((i) => !i.occurrences).map((i) => i.label).join(", ")}. Check the spelling matches what
                you typed; you can still upload.
              </div>
            )}
            {!!scrubbed.summary.skippedInputs.length && <div className="note">Too short to match safely (under 3 characters): {scrubbed.summary.skippedInputs.join(", ")}.</div>}
            <details>
              <summary className="small muted">See what was removed</summary>
              <table className="small">
                <tbody>
                  {scrubbed.summary.secrets.map((s) => (
                    <tr key={s.token}>
                      <td className="mono">{s.token}</td>
                      <td>{s.kind}</td>
                      <td className="num">{s.occurrences} places</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="primary" disabled={state === "uploading"} onClick={upload}>
                {state === "uploading" ? "Uploading and analysing…" : "Upload the cleaned recording"}
              </button>
            </div>
          </>
        )}
        {state === "done" && <div className="note ok">Received. Thank you, you can close the developer tools.</div>}
      </div>

      <div className="card">
        <h2>Later: verification result</h2>
        <p className="muted">If the engineer sends you a short snippet to run, paste what it printed here.</p>
        <textarea rows={4} value={verify} onChange={(e) => setVerify(e.target.value)} placeholder='{ "endpoint": "…", "status": 200, … }' />
        <div className="row" style={{ marginTop: 8 }}>
          <button disabled={!verify.trim()} onClick={sendVerify}>
            Send result
          </button>
          <span className="muted">{verifyMsg}</span>
        </div>
      </div>
    </>
  );
}

// ---------- engineer: report ----------

function CodeTabs({ tabs }: { tabs: [string, string][] }) {
  const [active, setActive] = useState(0);
  return (
    <div>
      <div className="tabs">
        {tabs.map(([name], i) => (
          <button key={name} className={i === active ? "active" : ""} onClick={() => setActive(i)}>
            {name}
          </button>
        ))}
        <span className="spacer" />
        <CopyButton text={tabs[active][1]} />
      </div>
      <pre>{tabs[active][1]}</pre>
    </div>
  );
}

function EndpointDetail({ ep, report, role }: { ep: Endpoint; report: Report; role?: string }) {
  const art = report.artifacts[ep.id];
  const sample = report.calls[ep.sampleCall];
  const params = report.llm.parameters.filter((p) => p.endpointId === ep.id);
  return (
    <div className={`card ${role === "primary" ? "pick" : ""}`}>
      <div className="row">
        <span className={`method ${ep.method}`}>{ep.method}</span>
        <b className="mono" style={{ fontSize: 15 }}>
          {short(ep)}
        </b>
        {role && <span className="pill on">{role}</span>}
        <span className="pill">score {ep.score}</span>
        <span className="pill">
          called {ep.calls.length}× · HTTP {ep.statuses.join(", ")}
        </span>
        <span className="pill">{ep.kind === "document" ? "page / form post" : "xhr / fetch"}</span>
      </div>

      <h3>Why it ranked here</h3>
      <ul className="tight reasons">
        {ep.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>

      {!!art?.variables.length && (
        <>
          <h3>Where each dynamic value comes from</h3>
          <table>
            <tbody>
              {art.variables.map((v) => (
                <tr key={v.name}>
                  <td className="mono">{v.name}</td>
                  <td>{v.from}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {!!params.length && (
        <>
          <h3>Parameters (model's reading)</h3>
          <table>
            <tbody>
              {params.map((p) => (
                <tr key={p.name}>
                  <td className="mono">{p.name}</td>
                  <td>{p.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {(ep.requestShape || ep.requestFields) && (
        <>
          <h3>Request body ({ep.requestMime})</h3>
          <div className="shape">{ep.requestShape ? summarizeShape(ep.requestShape, 4, 30) : ep.requestFields!.join(", ")}</div>
        </>
      )}
      <h3>Response ({ep.responseMime ?? "no body"})</h3>
      <div className="shape">{ep.responseShape ? summarizeShape(ep.responseShape, 4, 30) : sample.redirect ? `redirects to ${sample.redirect}` : "not JSON"}</div>

      {art && (
        <CodeTabs
          tabs={[
            ["curl", art.curl],
            ["TypeScript", art.typescript],
            ["Verify in their browser", art.verify],
            ["Sample response (scrubbed)", sample.responsePreview ?? "(no body recorded)"],
          ]}
        />
      )}
    </div>
  );
}

function ReportPage({ id }: { id: string }) {
  const [capture, setCapture] = useState<Capture | null>(null);
  const [error, setError] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const loadIt = () =>
    api<Capture>(`/api/captures/${id}`)
      .then((c) => {
        setCapture(c);
        setDescription(c.description);
      })
      .catch((e) => setError(e.message));
  useEffect(() => void loadIt(), [id]);

  if (error) return <p>{error}</p>;
  if (!capture) return <p className="muted">Loading…</p>;
  const report = capture.report;
  if (!report)
    return (
      <>
        <h1>{capture.title}</h1>
        <p>
          No recording yet. Send this link to the person at the clinic: <a href={`#/c/${id}`}>{`${location.origin}/#/c/${id}`}</a>
        </p>
      </>
    );

  const rerun = async () => {
    setBusy(true);
    try {
      setCapture(await api<Capture>(`/api/captures/${id}/reanalyze`, { description }));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const byId = new Map(report.endpoints.map((e) => [e.id, e]));
  const chosen = [...report.llm.supporting.map((s) => [s, "supporting"] as const), ...report.selected.map((s) => [s, "primary"] as const)]
    .map(([eid, role]) => ({ ep: byId.get(eid), role }))
    .filter((x): x is { ep: Endpoint; role: "supporting" | "primary" } => !!x.ep)
    .sort((a, b) => a.ep.calls[0] - b.ep.calls[0]);
  const m = report.meta;
  const dropped = Object.entries(m.dropped);

  return (
    <>
      <h1>{capture.title}</h1>
      <p className="muted">
        Recording received {when(capture.uploadedAt)} · {m.hosts.join(", ")} · <a href={`/api/captures/${id}/report.md`}>report.md</a> ·{" "}
        <a href={`/api/captures/${id}/openapi.json`}>openapi.json</a>
      </p>

      <div className="stats">
        <div>
          <b>{m.entries}</b>
          <span>requests recorded</span>
        </div>
        <div>
          <b>{m.kept}</b>
          <span>left after noise filter</span>
        </div>
        <div>
          <b>{report.endpoints.length}</b>
          <span>distinct endpoints</span>
        </div>
        <div>
          <b>{capture.scrub?.secrets.length ?? 0}</b>
          <span>credentials scrubbed client-side</span>
        </div>
      </div>
      <p className="muted small">{dropped.length ? `Filtered out: ${dropped.map(([k, n]) => `${n} ${k}`).join(", ")}.` : ""}</p>
      {report.warnings.map((w) => (
        <div className="note" key={w}>
          {w}
        </div>
      ))}

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Verdict</h2>
          <span className={`pill ${report.llm.used ? "on" : "warn"}`}>{report.llm.used ? `${report.llm.model} · confidence ${report.llm.confidence}` : "heuristic ranking"}</span>
        </div>
        <p style={{ marginTop: 10 }}>{report.llm.explanation}</p>
        {report.llm.error && <p className="muted small">{report.llm.error}</p>}
        {!!report.llm.caveats.length && (
          <ul className="tight">
            {report.llm.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
        {report.llm.nextCapture && (
          <div className="note">
            <b>Suggested next recording:</b> {report.llm.nextCapture}
          </div>
        )}
        <label>
          Workflow description <span className="muted">(edit and re-rank without a new recording)</span>
        </label>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={rerun} disabled={busy}>
            {busy ? "Re-ranking…" : "Re-rank"}
          </button>
        </div>
      </div>

      {chosen.map(({ ep, role }) => (
        <EndpointDetail key={ep.id} ep={ep} report={report} role={role} />
      ))}

      {!!capture.verifications.length && (
        <div className="card">
          <h2>Verification results from inside the network</h2>
          {capture.verifications.map((v, i) => (
            <div key={i}>
              <p className="small muted">{when(v.receivedAt)}</p>
              <pre style={{ borderRadius: 8 }}>{JSON.stringify(v.result, null, 2)}</pre>
            </div>
          ))}
        </div>
      )}

      {!!report.auth.length && (
        <div className="card">
          <h2>Authentication and session</h2>
          <table>
            <tbody>
              {report.auth.map((a) => (
                <tr key={a.type + a.name}>
                  <td>
                    <span className="pill">{a.type}</span>
                  </td>
                  <td className="mono">{a.name.replace(/ [^/ ]+\//, " /")}</td>
                  <td>{a.detail}</td>
                  <td className="num muted">{a.usedBy} calls</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>All candidates</h2>
        <p className="muted small">Click a row for its details and generated code.</p>
        <table>
          <thead>
            <tr>
              <th className="num">Score</th>
              <th>Endpoint</th>
              <th className="num">Calls</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {report.endpoints.map((ep) => (
              <Row key={ep.id} ep={ep} open={open === ep.id} toggle={() => setOpen(open === ep.id ? null : ep.id)}>
                <EndpointDetail ep={ep} report={report} />
              </Row>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Row({ ep, open, toggle, children }: { ep: Endpoint; open: boolean; toggle: () => void; children: ReactNode }) {
  return (
    <>
      <tr className="click" onClick={toggle}>
        <td className="num">{ep.score}</td>
        <td>
          <span className={`method ${ep.method}`}>{ep.method}</span>
          <span className="mono">{short(ep)}</span>
        </td>
        <td className="num">{ep.calls.length}</td>
        <td>{ep.statuses.join(", ")}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} style={{ background: "var(--bg)" }}>
            {children}
          </td>
        </tr>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
