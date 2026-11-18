# Portal API Finder

When a clinic employee does something in a web portal, like booking an appointment, the browser makes
one or more API calls behind the scenes. This tool finds which call that is, from a recording the
employee makes with the browser they already have. No installs, no extensions.

## How it works

CruiseControl's engineers can't log in to these portals, so the clinic employee does the work and we
only ever get a file.

1. An engineer creates a capture request in the service (what the workflow is, and which values the
   employee will type) and sends the employee a link.
2. The employee records the workflow in the browser's DevTools Network tab and exports a HAR file.
3. They drop the file on the link. Passwords, cookies and tokens are removed in their browser before
   anything is sent, and the page shows what was removed.
4. The engineer gets a report: the most likely API call, where each value in it comes from (a token
   from an earlier page, an id from an earlier search), how the session works, and a curl command,
   a TypeScript function and an OpenAPI file.
5. The report also has a snippet the employee can paste into the browser console. It replays the calls
   from inside their network and sends back only whether it worked. Calls that change data are a dry
   run unless you set `SEND = true`.

The service never calls the portal itself. The portals are only reachable from the customer's
network, so that was the one thing I wanted to avoid.

## How I built it

I used Claude to help create an initial version, then took the project through hands-on testing and refinement. I recorded workflows against a fake clinic portal and the public OpenMRS demo, worked through Windows build issues and Chrome’s HAR cookie settings, and fixed two ranking bugs that surfaced in the OpenMRS test. I also verified that the generated snippet could replay an appointment workflow in the browser.

## Running it

You need Node 20 or newer.

```
npm install
npm start               # the service, http://localhost:3000
npm run demo:portal     # a fake clinic portal, http://localhost:4000 (demo / demo-pass-123)
```

To try it:

1. On localhost:3000 create a capture request ("Book an appointment") and open its link.
2. Open a fresh Incognito window, press F12, go to Network and tick Preserve log. Then go to
   localhost:4000, sign in, search for `Zztest`, pick a patient, a provider and a slot, type a reason
   and click Book.
3. Chrome leaves cookies out of a normal HAR export, and without them the report has no session. In
   DevTools Settings > Preferences > Network, tick "Allow to generate HAR with sensitive data", then
   export with "Export HAR (with sensitive data)".
4. On the capture page enter what you typed, choose the file, check what the green box says it removed,
   and upload. Then open the report.
5. Paste the verify snippet into the console of the portal tab, fill in the inputs, run it once as a
   dry run and once with `SEND = true`, and paste the output back into the capture page.

To skip all that, two recordings are in `fixtures/`:

```
npm run analyze -- fixtures/demo-portal-chrome.har --workflow "Book an appointment" --input "patient last name=Zztest" --input "reason for visit=Follow-up visit for knee pain"
```

Tests: `npm test` (31 tests) and `npm run typecheck`.

There is an optional AI step. Put `OPENAI_API_KEY` in `.env` (see `.env.example`) to turn it on.
Without a key the ranking is just the score.

## What the code does with a recording

It's all in `src/core`, one step after another:

- **Scrub:** cookies, tokens, passwords and the typed values are swapped for placeholders like
  `{{secret:sid}}`. The same value always gets the same placeholder, so it can still be followed from
  one request to the next.
- **Filter:** drops images, scripts, trackers and preflight requests. Page loads and form posts stay,
  because in older portals the "API" is just a form post.
- **Normalize:** turns ids in URLs into templates like `{patientId}` and separates URLs that carry
  several actions (GraphQL, RPC methods, `?action=`).
- **Trace:** for every value a request sends, finds the earlier response where it first showed up.
- **Rank:** a plain score. Every point is listed in the report, so you can see why a call ranked
  where it did.
- **AI step (optional):** picks the main call from the ranked list. It can't invent endpoints, and if
  it fails the report just uses the score. Parsing, tracing and code generation stay in normal code
  because they need to be exact.

## What I tested

On my fake portal the right call ranks first for a JSON workflow (booking) and for an old-style form
post (a billing charge). I ran the verify snippet in a real console: the dry run passed, `SEND = true`
created the appointment (HTTP 201), and the result showed up in the report.

Then OpenMRS (public demo, "search for a patient", 136 requests). The search call came out first, but
when I looked at why, two things were wrong:

- My workflow text said "Sign in, search for...", and "sign" was on my list of write verbs. So the
  whole workflow counted as a write and every POST got +4. The search is a POST that only reads, so it
  won for the wrong reason. "Sign in" no longer counts as a write, and there's a test for it.
- With that bonus gone, the search dropped to third. It sends its data as plain `key=value` lines
  (DWR format), and the tracer only read forms, JSON, headers and cookies, so it never saw the name I
  typed. It now reads those lines when they hold a typed value or a secret. The search is first again,
  7.5 against 6, and this time for the right reasons.

Still weak on OpenMRS:

- `scriptSessionId` and `batchId` are made up by the page's JavaScript. One recording can't show
  that, so they stay hard-coded in the curl.
- The response is JavaScript, not JSON, so no response shape is shown.
- A CSRF token and a Cloudflare cookie were set before I started recording, so their origin is
  reported as unknown. The Cloudflare cookie also gets listed as a session cookie.
- In plain-text bodies only the lines with a typed value or a secret are traced. I didn't want it
  matching tiny constants like `1` by accident.

## What's missing

The biggest gap is that I never tried a real clinic portal, only my fake one and OpenMRS. The AI step
has only run against a mock server because I had no OpenAI key.

Also not handled:

- One recording can't tell a constant from a variable. Two recordings with different inputs could.
- Values the page changes before sending (reformatted dates, hashes, base64) are not traced.
- A token kept in `localStorage` isn't in a HAR. Recording the sign-in avoids that.
- Response bodies can contain patient data and are stored on the service. A real version should
  replace them with made-up values.
- The service has no login of its own. I also didn't solve how the employee's machine reaches a hosted
  copy of it, which matters because the portals are on a closed network.
- WebSockets are ignored, and DevTools might be turned off by policy on some clinic machines.
