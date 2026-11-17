// HTTP service. Two audiences use it:
//   - the implementation engineer creates a capture request and reads the report
//   - someone at the clinic opens the capture link, drops a HAR file, and uploads it
//     after it has been scrubbed in their browser
//
// State is a folder of JSON files (data/), which is enough for a take-home and easy to inspect.

import express from "express";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "./core/analyze.ts";
import { buildMarkdown } from "./core/generate.ts";
import { parseHar, type Har } from "./core/har.ts";
import { scrubHar, slug, type DeclaredInput, type ScrubSummary } from "./core/scrub.ts";
import type { Report } from "./core/types.ts";
import { addVerdict } from "./llm.ts";

try {
  process.loadEnvFile?.();
} catch {
  /* no .env file */
}

interface Capture {
  id: string;
  title: string;
  description: string;
  inputLabels: string[];
  createdAt: string;
  uploadedAt?: string;
  scrub?: ScrubSummary;
  verifications: { receivedAt: string; result: unknown }[];
  report?: Report;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR ?? join(root, "data");
mkdirSync(dataDir, { recursive: true });

const ID = /^[0-9a-f-]{36}$/;
const file = (id: string, ext: "json" | "har") => join(dataDir, `${id}.${ext}`);
const load = (id: string): Capture | undefined => (ID.test(id) && existsSync(file(id, "json")) ? JSON.parse(readFileSync(file(id, "json"), "utf8")) : undefined);
const save = (c: Capture) => writeFileSync(file(c.id, "json"), JSON.stringify(c));

async function runAnalysis(capture: Capture, har: Har): Promise<void> {
  const report = analyze(har, { description: `${capture.title}. ${capture.description}`.trim(), inputs: capture.inputLabels.map(slug) });
  await addVerdict(report);
  capture.report = report;
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "200mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, llm: !!process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || "gpt-4.1" });
  });

  app.get("/api/captures", (_req, res) => {
    const list = readdirSync(dataDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => load(f.slice(0, -5)))
      .filter((c): c is Capture => !!c)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        createdAt: c.createdAt,
        uploadedAt: c.uploadedAt,
        selected: c.report?.selected ?? [],
        verifications: c.verifications.length,
      }));
    res.json(list);
  });

  app.post("/api/captures", (req, res) => {
    const title = String(req.body?.title ?? "").trim();
    if (!title) return void res.status(400).json({ error: "A workflow title is required." });
    const capture: Capture = {
      id: randomUUID(),
      title,
      description: String(req.body?.description ?? "").trim(),
      inputLabels: (Array.isArray(req.body?.inputLabels) ? req.body.inputLabels : []).map((l: unknown) => String(l).trim()).filter(Boolean).slice(0, 20),
      createdAt: new Date().toISOString(),
      verifications: [],
    };
    save(capture);
    res.status(201).json(capture);
  });

  // What the recorder at the clinic sees: the instructions, never the report.
  app.get("/api/captures/:id/public", (req, res) => {
    const c = load(req.params.id);
    if (!c) return void res.status(404).json({ error: "Unknown capture link." });
    res.json({ id: c.id, title: c.title, description: c.description, inputLabels: c.inputLabels, uploaded: !!c.uploadedAt });
  });

  app.get("/api/captures/:id", (req, res) => {
    const c = load(req.params.id);
    if (!c) return void res.status(404).json({ error: "Unknown capture." });
    res.json(c);
  });

  app.post("/api/captures/:id/har", async (req, res) => {
    const c = load(req.params.id);
    if (!c) return void res.status(404).json({ error: "Unknown capture link." });
    try {
      // The browser has already scrubbed the file. Scrubbing again here is idempotent and
      // protects against raw HARs posted straight to the API.
      const inputs: DeclaredInput[] = Array.isArray(req.body?.inputs) ? req.body.inputs : [];
      const { har, summary } = scrubHar(parseHar(req.body?.har), inputs);
      const clientSummary = req.body?.summary as ScrubSummary | undefined;
      c.scrub = clientSummary?.secrets ? clientSummary : summary;
      c.uploadedAt = new Date().toISOString();
      writeFileSync(file(c.id, "har"), JSON.stringify(har));
      await runAnalysis(c, har);
      save(c);
      res.json({ ok: true, kept: c.report!.meta.kept, endpoints: c.report!.endpoints.length });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The engineer can sharpen the description and re-rank without asking for a new recording.
  app.post("/api/captures/:id/reanalyze", async (req, res) => {
    const c = load(req.params.id);
    if (!c || !existsSync(file(c.id, "har"))) return void res.status(404).json({ error: "No recording uploaded yet." });
    if (typeof req.body?.title === "string" && req.body.title.trim()) c.title = req.body.title.trim();
    if (typeof req.body?.description === "string") c.description = req.body.description.trim();
    await runAnalysis(c, parseHar(readFileSync(file(c.id, "har"), "utf8")));
    save(c);
    res.json(c);
  });

  app.post("/api/captures/:id/verifications", (req, res) => {
    const c = load(req.params.id);
    if (!c) return void res.status(404).json({ error: "Unknown capture link." });
    let result: unknown = req.body?.result;
    if (typeof result === "string") {
      try {
        result = JSON.parse(result);
      } catch {
        return void res.status(400).json({ error: "That is not the JSON the snippet printed." });
      }
    }
    if (!result || typeof result !== "object") return void res.status(400).json({ error: "Empty result." });
    c.verifications.push({ receivedAt: new Date().toISOString(), result });
    save(c);
    res.json({ ok: true });
  });

  app.get("/api/captures/:id/report.md", (req, res) => {
    const c = load(req.params.id);
    if (!c?.report) return void res.status(404).send("No report yet.");
    res.type("text/markdown").send(buildMarkdown(c.report));
  });

  app.get("/api/captures/:id/openapi.json", (req, res) => {
    const c = load(req.params.id);
    if (!c?.report) return void res.status(404).send("No report yet.");
    res.json(c.report.openapi);
  });

  app.use(express.static(join(root, "public")));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => {
    console.log(`Portal API Finder on http://localhost:${port}`);
    console.log(process.env.OPENAI_API_KEY ? `LLM step: on (${process.env.OPENAI_MODEL || "gpt-4.1"})` : "LLM step: off (set OPENAI_API_KEY to enable); heuristic ranking only");
  });
}
