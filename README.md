# Portal API Finder

Finds the internal API call behind a workflow in a clinic web portal, from a recording made with
nothing but the browser the clinic already has.

An engineer describes a workflow and sends a link. Someone at the clinic records the workflow with
the browser's built-in DevTools and drops the exported HAR file on that link. The engineer gets back:

- the request(s) that perform the workflow, ranked, with the reasons for the ranking
- **where every dynamic value in that request comes from** (this CSRF token is in that page's `<meta>`
  tag, this patient id is `$.results[0].id` of that search call, this field is what the user typed)
- how the session and CSRF protection work
- a curl command, a typed TypeScript function and an OpenAPI document
- a **verification snippet** the clinic employee pastes into the browser console, which replays the
  call chain from inside their network and reports back whether it worked

## Run it

Requires Node 20+.

```bash
npm install
cp .env.example .env        # optional: add OPENAI_API_KEY to enable the LLM step
npm start                   # service on http://localhost:3000
npm run demo:portal         # fake clinic portal on http://localhost:4000 (demo / demo-pass-123)
```

Five-minute walkthrough:

1. On `localhost:3000`, create a capture request: workflow "Book an appointment", values typed
   "patient last name, reason for visit". Open its capture link.
2. In another tab open `localhost:4000`, open DevTools → Network, tick Preserve log, sign in, search
   for `Zztest`, pick a patient, a provider and a slot, type a reason, click Book. Export the HAR.
3. On the capture page, enter what you typed and drop the HAR. The page shows what it removed.
   Upload, then open the report.
4. Copy the "Verify in their browser" snippet into the console of the portal tab. Set the inputs,
   run it once as a dry run, then with `SEND = true`. Paste the printed result back into the
   capture page; it shows up on the report.

No browser at hand? Two recordings are checked in:

```bash
npm run analyze -- fixtures/demo-portal-chrome.har \
  --workflow "Search for a patient and book an appointment" \
  --input "patient last name=Zztest" --input "reason for visit=Follow-up visit for knee pain"
# writes out/report.md, report.json, openapi.json, scrubbed.har
```

```bash
npm test          # 29 tests
npm run typecheck
```

## How the constraints shaped the design

| Constraint from the brief | Consequence |
|---|---|
| Nothing can be installed, no extensions | Capture uses what every browser ships: DevTools → Export HAR. |
| No remote or hosted browsers | The clinic employee does the workflow themselves; the service only ever sees a file. |
| Portal only reachable inside the customer network; engineers cannot log in | The service never calls the portal. Verification runs in the employee's own tab via a generated console snippet, using the session they already have. |
| The work lands on the most senior engineers | The report answers the questions a senior engineer would ask of a HAR (which call, what is dynamic, where does it come from, how is it authenticated), so someone less experienced can build from it. |
| It is a clinic | The recording is scrubbed in the employee's browser before upload. Credentials never leave the machine. See "Privacy". |

The recorder is not an engineer, so the capture page is written for them: four steps, plain words.

## How it works

```
HAR ──scrub──▶ filter ──▶ normalise ──▶ trace ──▶ rank ──▶ (LLM verdict) ──▶ generate
     browser    noise      endpoints     value      heuristics  optional        curl / TS /
     side                                provenance                             OpenAPI / verify
```

Everything up to the LLM step is deterministic, has no dependencies, and lives in `src/core`. The
same code runs in the browser (scrubbing) and in Node.

1. **Scrub** (`scrub.ts`). Each credential-like value (cookies, `Authorization`, CSRF tokens,
   passwords, JWTs, token-named fields in JSON, forms and HTML) is replaced everywhere it occurs by
   a stable placeholder such as `{{secret:sid}}`. Values the recorder says they typed become
   `{{input:patient_last_name}}`. Because a value always maps to the same placeholder, later steps
   can still follow it from response to request without knowing it. Asset bodies are dropped.
2. **Filter** (`filter.ts`). Drops assets, trackers, preflights. Keeps xhr/fetch **and** page loads
   and form posts, because most legacy EHRs are server-rendered and the "API" is a form post.
3. **Normalise** (`normalize.ts`). Templates ids in paths (`/patients/{patientId}`), and splits
   URLs that multiplex many actions: GraphQL operation, JSON-RPC method, SOAPAction, `?action=`.
4. **Trace** (`trace.ts`). For each value a request sends, find the earlier response that first
   contained it: JSON leaves, hidden inputs, `<meta>` tags, `Set-Cookie`, `Location`, links. When a
   value appears in several places it prefers a structured source, then a matching field name, then
   the most recent. Echoes are ignored (a response repeating its own request is not an origin).
5. **Rank** (`rank.ts`). Additive, explainable scoring: does the method fit the intent of the
   description, does the request carry what the recorder typed, do URL and field names match the
   description, is it telemetry or polling. Every point is listed in the report.
6. **LLM verdict** (`src/llm.ts`, optional). See below.
7. **Generate** (`generate.ts`). Every dynamic value becomes a named variable with its origin as a
   comment. The verify snippet resolves the dependency chain at run time (re-fetches the page for
   the CSRF token, re-runs the search for the id), defaults to a dry run for calls that change
   data, and reports only the response structure.

## What the LLM does, and does not do

The model gets the workflow description and the top 25 candidate endpoints: templates, field
names, shapes, placeholder tokens, and the traced dependencies. It returns which call(s) perform
the workflow, which supporting calls are needed first, what each parameter means, caveats, and
what to record next if one recording is not enough.

It does not parse the HAR, and it cannot add endpoints: ids it returns are checked against the
report and unknown ones are dropped. If there is no key, or the call fails, the report falls back
to the heuristic ranking and says so. I chose this split because filtering, tracing and code
generation need to be exact and reproducible, while "does `save.php?action=save` look like adding
a billing charge" is a judgement call that models are good at.

Model is set with `OPENAI_MODEL` (default `gpt-4.1`, any chat-completions model with JSON mode).

## Privacy

- Credentials and typed values are replaced in the browser. The capture page shows what was
  removed before the upload button is enabled. The server scrubs again (idempotent) in case a raw
  HAR is posted to the API directly.
- The LLM prompt contains structure only. Free-text and long numeric values are masked.
- **Not solved:** response bodies can still contain patient data (a search result lists names).
  The scrubbed HAR and a 1,500-character response preview are stored on the service. The capture
  page asks for a test patient; a production version should offer a structure-only mode that
  replaces every response string with a stable pseudonym, which keeps tracing working.
- No auth on the service itself; capture ids are unguessable UUIDs. Fine for a take-home, not for
  production.

## What has been verified, and what has not

Verified by the test suite:

- Scrubbing removes every occurrence of the session id, CSRF token, password and typed values, is
  idempotent, and keeps JSON valid.
- On the demo portal the right call ranks first for both a JSON-API workflow (book appointment)
  and a legacy form-post workflow (add billing charge), with correct provenance for every value.
- The generated verify snippet is executed against a live demo portal with a fresh session and
  actually books the appointment (201) and submits the form.
- A HAR recorded by real Chrome driving the demo portal UI gives the same result as the scripted one.
- The service flow end to end, including the LLM path against a mock OpenAI server (verdict
  applied, invented endpoint dropped, fallback on failure, nothing sensitive in the prompt).

Not verified:

- **No real portal yet.** The demo portal is mine, so it contains the patterns I thought of. The
  next step is the OpenEMR public demo; I expect the filter and tracer to need tuning there.
- **No real OpenAI call yet.** The prompt and parsing are tested against a mock only.
- HARs exported from DevTools by hand (the fixtures come from a script and from Playwright's HAR
  recorder; the format is the same but DevTools adds fields I have not exercised).

## Limitations and what I would do next

- **One recording cannot tell a constant from a variable.** `visitType: "office"` is reported as
  constant because nothing says otherwise. Diffing two recordings of the same workflow with
  different inputs would settle it; the LLM's "suggested next recording" is a stopgap.
- **Transformed values are not traced**: a typed date reformatted by the frontend, a value that is
  hashed, encrypted or base64-wrapped, or an id assembled from parts.
- **Client-side state is invisible to a HAR.** A bearer token read from `localStorage` before the
  recording started has no origin in the file; it is reported as such and the verify snippet looks
  in browser storage as a fallback. Recording the sign-in avoids this.
- **WebSockets and streaming** are filtered out, not analysed.
- **DevTools may be disabled by policy** on some machines. `chrome://net-export` is a possible
  fallback but does not include bodies.
- HAR upload is a single JSON POST; very large recordings (100 MB+) need chunking.
- A library of solved portals: the same EHR at the next customer has the same endpoints.

## Layout

```
src/core/      deterministic pipeline (isomorphic, no dependencies)
src/llm.ts     optional OpenAI step
src/server.ts  Express API + static UI; state is JSON files in data/
src/cli.ts     analyse a HAR from the command line
web/           React UI: capture requests, recorder page, report
demo/          fake clinic portal to record against
scripts/       scripted recorder that regenerates fixtures/demo-portal.har
fixtures/      two recordings of the demo portal (scripted, and real Chrome)
test/          pipeline and service tests
```
