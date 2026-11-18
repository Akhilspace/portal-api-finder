# Portal API Finder

A small service that helps find the internal API call behind a workflow in a clinic web portal, using
only the browser the clinic already has.

## The idea

CruiseControl's engineers can't log in to the clinic portals, and nothing can be installed on the
clinic machines. So the clinic employee does the work and we only receive a file:

1. An engineer creates a "capture request" in the service: a short description of the workflow, for
   example "book an appointment", plus a list of the values the employee will type.
2. The engineer sends the employee a link. The employee opens the portal, records the workflow with
   the browser's DevTools (Network tab) and exports a HAR file.
3. The employee drops the HAR file on the link. Passwords, cookies and tokens are removed in their
   browser before anything is sent, and the page shows what was removed.
4. The engineer opens a report: which request does the workflow, where each value in it comes from
   (a token in an earlier page, an id from an earlier search), how the session works, and a curl
   command, a TypeScript function and an OpenAPI file for it.
5. The report also has a short snippet the employee pastes into the browser console. It replays the
   calls from inside their network and sends back only whether it worked. Calls that change data are a
   dry run unless `SEND = true` is set.

The service never calls the portal itself. That is the main design choice, because the portals are
only reachable from the customer's network.

## How I built it

I used Claude to write most of the first version of the code. After that I ran it, recorded real
workflows against a fake clinic portal and against the public OpenMRS demo, fixed what broke on my
Windows machine, and wrote down where the tool is weak. The sections below are about what I saw.

## Running it

You need Node 20 or newer.

```
npm install
npm start               # the service, on http://localhost:3000
npm run demo:portal     # a fake clinic portal, on http://localhost:4000 (demo / demo-pass-123)
```

To try it:

1. On localhost:3000, create a capture request ("Book an appointment") and open its link.
2. Open a fresh Incognito window, press F12, go to Network and tick Preserve log. Then open
   localhost:4000, sign in, search for `Zztest`, pick a patient, a provider and a slot, type a reason
   and click Book.
3. Important: Chrome leaves cookies out of a normal HAR export. In DevTools Settings > Preferences >
   Network, tick "Allow to generate HAR with sensitive data", then export with "Export HAR (with
   sensitive data)". Without it the report has no session cookie. This one cost me some time.
4. On the capture page, enter what you typed, choose the file, check the green box and upload. Then
   open the report.
5. Paste the verify snippet into the console of the portal tab, fill in the inputs, run it once as a
   dry run and once with `SEND = true`. Paste the output back into the capture page.

If you just want to see a report, there are two recordings in `fixtures/`:

```
npm run analyze -- fixtures/demo-portal-chrome.har --workflow "Book an appointment" --input "patient last name=Zztest" --input "reason for visit=Follow-up visit for knee pain"
```

Tests: `npm test` and `npm run typecheck`.

An OpenAI key is optional (`OPENAI_API_KEY` in `.env`, see `.env.example`). Without it the report
uses the scoring only.

## What it does with a recording

Everything is in `src/core`, in this order:

- **Scrub.** Cookies, tokens, passwords and the values the employee typed are swapped for
  placeholders like `{{secret:sid}}`. A value always gets the same placeholder, so it can still be
  followed from one request to the next.
- **Filter.** Throws away images, scripts, trackers and preflight requests. Page loads and form posts
  stay, because older portals are server-rendered and the "API" is a form post.
- **Normalize.** Turns ids in URLs into `{patientId}` style templates and separates URLs that carry
  several actions (GraphQL operations, RPC methods, `?action=`).
- **Trace.** For every value a request sends, finds the earlier response where it first appeared.
- **Rank.** A plain additive score. Each point is listed in the report so you can see why.
- **AI step (optional, `src/llm.ts`).** The model only picks the main call from the already ranked
  list. It can't add endpoints, and if it fails the report falls back to the score. I kept the exact
  parts (parsing, tracing, code generation) out of the model on purpose.

## What I tested

On my fake portal the right call ranks first for a JSON workflow (booking) and for an old-style form
post (a billing charge). I ran the verify snippet in a real console: the dry run passed and `SEND =
true` created the appointment (HTTP 201), and the result showed up in the report.

On the public OpenMRS demo I recorded "search for a patient" (136 requests). The search request came
out first. The session id was traced to the login and the typed name to what I entered. What didn't
go well:

- The score adds 4 points to any POST because it assumes POST changes data. This search is a POST
  that only reads, so it came first partly for the wrong reason. This is the first thing I would fix.
- `scriptSessionId` and `batchId` are made up by the page's JavaScript. One recording can't show
  that, so they stay hard-coded in the curl.
- The response is JavaScript, not JSON, so no response shape is shown.
- A CSRF token and a Cloudflare cookie were set before I started recording, so the report says their
  origin is unknown. The Cloudflare cookie also gets listed as a session cookie.

## Not done

- The AI step has only run against a mock server. I had no OpenAI key.
- I have not tried a real clinic portal, only my fake one and OpenMRS.
- One recording can't tell a constant from a variable. Two recordings with different inputs could.
- Values the page changes before sending (reformatted dates, hashes, base64) are not traced.
- A token kept in `localStorage` is not in a HAR. Recording the sign-in avoids this.
- WebSockets are ignored. DevTools might be switched off by policy on some clinic machines.
- Response bodies can contain patient data and are stored on the service. A real version should
  replace them with made-up values.
- The service has no login. I also did not solve how the employee's machine reaches a hosted copy of
  it, which matters because the portals are on a closed network.

## Folders

```
src/core/      the pipeline (also used in the browser for scrubbing)
src/llm.ts     optional AI step
src/server.ts  the API and the page; data is saved as JSON files in data/
src/cli.ts     run a HAR file from the command line
web/           the React pages: capture requests, recorder, report
demo/          the fake clinic portal
scripts/       records fixtures/demo-portal.har
fixtures/      two recordings of the fake portal
test/          tests
```
