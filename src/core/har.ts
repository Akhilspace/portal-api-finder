// Minimal HAR 1.2 types (only what we read) plus small isomorphic helpers.
// Everything in src/core runs unchanged in Node and in the browser.

export interface NameValue {
  name: string;
  value: string;
}

export interface HarPostData {
  mimeType?: string;
  text?: string;
  params?: { name: string; value?: string; fileName?: string; contentType?: string }[];
}

export interface HarContent {
  size?: number;
  mimeType?: string;
  text?: string;
  encoding?: string;
}

export interface HarEntry {
  startedDateTime: string;
  time?: number;
  request: {
    method: string;
    url: string;
    headers: NameValue[];
    queryString?: NameValue[];
    cookies?: NameValue[];
    postData?: HarPostData;
  };
  response: {
    status: number;
    statusText?: string;
    headers: NameValue[];
    cookies?: NameValue[];
    content?: HarContent;
    redirectURL?: string;
  };
  _resourceType?: string;
  [extra: string]: unknown;
}

export interface Har {
  log: {
    version?: string;
    creator?: unknown;
    pages?: unknown[];
    entries: HarEntry[];
  };
}

export function parseHar(input: string | unknown): Har {
  let data: unknown = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input.replace(/^﻿/, ""));
    } catch {
      throw new Error("That file is not valid JSON, so it is not a HAR export.");
    }
  }
  const har = data as Har;
  if (!har || typeof har !== "object" || !har.log || !Array.isArray(har.log.entries)) {
    throw new Error("That JSON has no log.entries array, so it is not a HAR export.");
  }
  for (const e of har.log.entries) {
    if (!e.request || !e.response) throw new Error("HAR entry is missing request/response.");
    e.request.headers ??= [];
    e.response.headers ??= [];
  }
  return har;
}

export function header(headers: NameValue[] | undefined, name: string): string | undefined {
  const n = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === n)?.value;
}

export function baseMime(mime: string | undefined): string {
  return (mime ?? "").split(";")[0].trim().toLowerCase();
}

export function isTextMime(mime: string | undefined): boolean {
  const m = baseMime(mime);
  return (
    m.startsWith("text/") ||
    m.includes("json") ||
    m.includes("xml") ||
    m.includes("javascript") ||
    m.includes("x-www-form-urlencoded") ||
    m.includes("graphql")
  );
}

/** Decode a base64 string to UTF-8 text (works in Node >= 16 and browsers). */
export function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Response body as text, or undefined when absent / binary. */
export function responseText(entry: HarEntry): string | undefined {
  const c = entry.response.content;
  if (!c || typeof c.text !== "string" || c.text === "") return undefined;
  if (c.encoding === "base64") {
    if (!isTextMime(c.mimeType)) return undefined;
    try {
      return decodeBase64Utf8(c.text);
    } catch {
      return undefined;
    }
  }
  return c.text;
}

export function safeUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function tryJson(text: string | undefined): { ok: true; value: unknown } | { ok: false } {
  if (text === undefined) return { ok: false };
  const t = text.trim();
  if (!t || !/^[\[{"\d\-tfn]/.test(t)) return { ok: false };
  // Some frameworks prefix JSON with an anti-hijacking guard such as )]}',
  const cleaned = t.replace(/^\)\]\}',?\s*/, "").replace(/^while\(1\);/, "");
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch {
    return { ok: false };
  }
}

export const TOKEN_RE = /\{\{(secret|input):([^}]+)\}\}/g;
export function hasToken(s: string): boolean {
  return /\{\{(secret|input):[^}]+\}\}/.test(s);
}
