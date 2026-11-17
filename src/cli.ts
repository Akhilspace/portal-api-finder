// Command-line entry point, for engineers who already have a HAR file in hand.
//
//   npm run analyze -- recording.har --workflow "book an appointment" \
//       --input "patient last name=Zztest" --out out/

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "./core/analyze.ts";
import { buildMarkdown } from "./core/generate.ts";
import { parseHar } from "./core/har.ts";
import { scrubHar, slug, type DeclaredInput } from "./core/scrub.ts";
import { addVerdict } from "./llm.ts";

try {
  process.loadEnvFile?.();
} catch {
  /* no .env file */
}

const args = process.argv.slice(2);
const flag = (name: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === `--${name}` && args[i + 1]) out.push(args[++i]);
  return out;
};
const file = args.find((a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--"));
if (!file) {
  console.error('Usage: npm run analyze -- <file.har> --workflow "what the user did" [--input "label=value"]... [--out dir] [--no-llm]');
  process.exit(1);
}

const inputs: DeclaredInput[] = flag("input").map((kv) => {
  const i = kv.indexOf("=");
  return { label: kv.slice(0, i), value: kv.slice(i + 1) };
});
const description = flag("workflow")[0] ?? "";
const outDir = flag("out")[0] ?? "out";

const { har, summary } = scrubHar(parseHar(readFileSync(file, "utf8")), inputs);
const report = analyze(har, { description, inputs: inputs.map((i) => slug(i.label)) });
await addVerdict(report, args.includes("--no-llm") ? {} : process.env);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
writeFileSync(join(outDir, "report.md"), buildMarkdown(report));
writeFileSync(join(outDir, "openapi.json"), JSON.stringify(report.openapi, null, 2));
writeFileSync(join(outDir, "scrubbed.har"), JSON.stringify(har));

console.log(`Scrubbed ${summary.secrets.length} credentials and ${summary.inputs.length} typed values; dropped ${summary.bodiesDropped} asset bodies.`);
console.log(`${report.meta.entries} requests -> ${report.meta.kept} kept -> ${report.endpoints.length} endpoints.\n`);
for (const ep of report.endpoints.slice(0, 8)) {
  console.log(`${report.selected.includes(ep.id) ? "=>" : "  "} ${String(ep.score).padStart(6)}  ${ep.method} ${ep.pathTemplate}${ep.operation ? ` [${ep.operation}]` : ""}`);
}
console.log(`\n${report.llm.explanation}`);
if (report.llm.error) console.log(`(${report.llm.error})`);
for (const w of report.warnings) console.log(`Warning: ${w}`);
console.log(`\nWrote report.md, report.json, openapi.json and scrubbed.har to ${outDir}/`);
