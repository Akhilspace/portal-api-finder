import express from "express";
import { mkdtempSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const rawHar = JSON.parse(readFileSync(new URL("../fixtures/demo-portal.har", import.meta.url), "utf8"));
const rawText = JSON.stringify(rawHar);
const sid = /sid=([0-9a-f]{32})/.exec(rawText)![1];

let api: Server;
let openai: Server;
let base = "";
let prompt: { model: string; messages: { role: string; content: string }[] } | undefined;
let openaiMode: "ok" | "down" = "ok";

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (path: string) => fetch(base + path).then((r) => r.json());

beforeAll(async () => {
  // A stand-in for the OpenAI API that records the prompt it was sent.
  const mock = express();
  mock.use(express.json({ limit: "10mb" }));
  mock.post("/v1/chat/completions", (req, res) => {
    prompt = req.body;
    if (openaiMode === "down") return void res.status(500).json({ error: "boom" });
    const verdict = {
      primary: ["POST localhost:4000/api/appointments", "POST localhost:4000/api/made-up-by-the-model"],
      supporting: ["GET localhost:4000/api/patients", "GET localhost:4000/api/providers/{providerId}/slots"],
      explanation: "The booking is the POST to /api/appointments.",
      parameters: [{ endpointId: "POST localhost:4000/api/appointments", name: "slotId", meaning: "The slot chosen from the provider's availability." }],
      confidence: "high",
      caveats: ["visitType was constant in this recording."],
      nextCapture: null,
    };
    res.json({ choices: [{ message: { content: JSON.stringify(verdict) } }] });
  });
  openai = mock.listen(0);
  await new Promise((r) => openai.once("listening", r));

  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "paf-"));
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `http://localhost:${(openai.address() as AddressInfo).port}/v1`;
  const { createApp } = await import("../src/server.ts");
  api = createApp().listen(0);
  await new Promise((r) => api.once("listening", r));
  base = `http://localhost:${(api.address() as AddressInfo).port}`;
});

afterAll(() => {
  api.close();
  openai.close();
});

describe("service", () => {
  let id = "";

  it("creates a capture request and exposes only instructions to the recorder", async () => {
    const res = await post("/api/captures", { title: "Book an appointment", description: "Search the test patient, pick a slot, book.", inputLabels: ["patient last name", "reason for visit"] });
    expect(res.status).toBe(201);
    id = res.body.id;
    const pub = await get(`/api/captures/${id}/public`);
    expect(pub).toMatchObject({ title: "Book an appointment", inputLabels: ["patient last name", "reason for visit"], uploaded: false });
    expect(pub.report).toBeUndefined();
  });

  it("scrubs a raw HAR posted straight to the API, analyses it and stores nothing sensitive", async () => {
    const res = await post(`/api/captures/${id}/har`, {
      har: rawHar,
      inputs: [
        { label: "patient last name", value: "Zztest" },
        { label: "reason for visit", value: "Follow-up visit for knee pain" },
      ],
    });
    expect(res.status).toBe(200);
    const stored = readFileSync(join(process.env.DATA_DIR!, `${id}.har`), "utf8") + readFileSync(join(process.env.DATA_DIR!, `${id}.json`), "utf8");
    for (const secret of [sid, "demo-pass-123", "Zztest", "knee pain"]) expect(stored).not.toContain(secret);
  });

  it("applies the model's verdict but drops endpoints the model invented", async () => {
    const c = await get(`/api/captures/${id}`);
    expect(c.report.llm).toMatchObject({ used: true, confidence: "high" });
    expect(c.report.selected).toEqual(["POST localhost:4000/api/appointments"]);
    expect(c.report.llm.supporting).toHaveLength(2);
  });

  it("sends the model structure only: no credentials, no typed values, no free text", () => {
    const sent = JSON.stringify(prompt);
    for (const secret of [sid, "demo-pass-123", "Zztest", "knee pain", "Avery"]) expect(sent).not.toContain(secret);
    expect(sent).toContain("{{input:reason_for_visit}}");
    expect(sent).toContain("/api/appointments");
  });

  it("falls back to the heuristic ranking when the model is unavailable", async () => {
    openaiMode = "down";
    const res = await post(`/api/captures/${id}/reanalyze`, { description: "Search the test patient, pick a slot, book the appointment." });
    openaiMode = "ok";
    expect(res.body.report.llm.used).toBe(false);
    expect(res.body.report.llm.error).toContain("500");
    expect(res.body.report.selected).toEqual(["POST localhost:4000/api/appointments"]);
  });

  it("stores verification results and serves the exports", async () => {
    const ok = await post(`/api/captures/${id}/verifications`, { result: '{"endpoint":"POST /api/appointments","sent":true,"status":201}' });
    expect(ok.status).toBe(200);
    expect((await post(`/api/captures/${id}/verifications`, { result: "not json" })).status).toBe(400);
    const c = await get(`/api/captures/${id}`);
    expect(c.verifications[0].result.status).toBe(201);
    expect(await fetch(`${base}/api/captures/${id}/report.md`).then((r) => r.text())).toContain("## Ranked candidates");
    expect((await get(`/api/captures/${id}/openapi.json`)).openapi).toBe("3.1.0");
  });

  it("rejects files that are not HAR and unknown capture ids", async () => {
    expect((await post(`/api/captures/${id}/har`, { har: { nope: true } })).status).toBe(400);
    expect((await post(`/api/captures/00000000-0000-0000-0000-000000000000/har`, { har: rawHar })).status).toBe(404);
  });
});
