// Noise filter: decide which HAR entries can possibly be "the call behind the workflow".
// A typical portal recording is 80-95% assets, analytics and polling.

import { HarEntry, baseMime, safeUrl } from "./har.ts";

export type EntryKind = "api" | "document" | "static" | "tracker" | "preflight" | "failed" | "other";

export interface Verdict {
  keep: boolean;
  kind: EntryKind;
  reason: string;
}

const STATIC_EXT =
  /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|eot|otf|mp4|webm|mp3|wav|pdf|zip|wasm)$/i;
const STATIC_MIME = /^(image\/|font\/|video\/|audio\/|text\/css|text\/javascript|application\/(javascript|x-javascript|wasm|font))/;
const TRACKER_HOST =
  /(google-analytics|googletagmanager|doubleclick|googlesyndication|google\.com\/(pagead|ads)|facebook\.(com|net)|hotjar|segment\.(io|com)|mixpanel|amplitude|sentry\.io|bugsnag|datadoghq|newrelic|nr-data|fullstory|intercom|clarity\.ms|optimizely|launchdarkly|pendo\.io|heap(analytics)?\.|cookiebot|onetrust|gstatic\.com|fonts\.googleapis)/i;

export function classify(e: HarEntry): Verdict {
  const method = e.request.method.toUpperCase();
  const url = safeUrl(e.request.url);
  if (!url || !/^https?:$/.test(url.protocol)) return { keep: false, kind: "other", reason: "non-http url" };
  if (method === "OPTIONS") return { keep: false, kind: "preflight", reason: "CORS preflight" };
  if (TRACKER_HOST.test(url.host + url.pathname)) return { keep: false, kind: "tracker", reason: "analytics / third-party tracker" };

  const type = (e._resourceType ?? "").toLowerCase();
  const mime = baseMime(e.response.content?.mimeType);
  const mutating = method !== "GET" && method !== "HEAD";

  if (type === "websocket" || url.protocol.startsWith("ws")) return { keep: false, kind: "other", reason: "websocket (not analysed)" };
  if (e.response.status === 0 && !mutating) return { keep: false, kind: "failed", reason: "no response (blocked or cancelled)" };

  if (!mutating) {
    if (/^(image|font|stylesheet|script|media|manifest|texttrack)$/.test(type)) return { keep: false, kind: "static", reason: "static asset" };
    if (STATIC_EXT.test(url.pathname)) return { keep: false, kind: "static", reason: "static asset" };
    if (STATIC_MIME.test(mime)) return { keep: false, kind: "static", reason: "static asset" };
  }

  if (type === "document" || (mime.includes("html") && !mutating && type !== "xhr" && type !== "fetch")) {
    // Server-rendered portals (most legacy EHRs) do their work in page loads and form posts,
    // and GET pages are where CSRF tokens and record ids come from, so documents are kept.
    return { keep: true, kind: "document", reason: mutating ? "form post" : "page load" };
  }
  return { keep: true, kind: "api", reason: type === "xhr" || type === "fetch" ? "xhr/fetch" : mutating ? "mutating request" : "data request" };
}
