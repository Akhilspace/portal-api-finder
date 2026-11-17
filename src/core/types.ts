import type { NameValue } from "./har.ts";
import type { EntryKind } from "./filter.ts";
import type { ParsedBody } from "./normalize.ts";
import type { Shape } from "./shape.ts";

export type Loc = "path" | "query" | "header" | "cookie" | "body";
export type Via = "json" | "html-input" | "html-meta" | "html-link" | "set-cookie" | "header";

/** Where a request value comes from. This is the core output of the tracer. */
export type Source =
  | { kind: "input"; label: string }
  | { kind: "response"; callIndex: number; endpointId: string; via: Via; path: string }
  | { kind: "secret"; token: string } // a credential whose origin is not in the recording
  | { kind: "literal" }; // constant as far as one recording can tell

export interface Binding {
  in: Loc;
  name: string;
  value: string;
  /** Substring of `value` that is bound (e.g. the token part of "Bearer <token>"). */
  match: string;
  source: Source;
}

export interface Call {
  index: number;
  harIndex: number;
  startedAt: string;
  method: string;
  url: string;
  origin: string;
  host: string;
  path: string;
  pathTemplate: string;
  endpointId: string;
  operation?: string;
  kind: EntryKind;
  resourceType?: string;
  status: number;
  redirect?: string;
  requestMime?: string;
  responseMime?: string;
  query: NameValue[];
  headers: NameValue[];
  cookies: NameValue[];
  body: ParsedBody;
  bindings: Binding[];
  responsePreview?: string;
  responseShape?: Shape;
  score: number;
  reasons: string[];
}

export interface Endpoint {
  id: string;
  method: string;
  host: string;
  pathTemplate: string;
  operation?: string;
  kind: EntryKind;
  calls: number[];
  statuses: number[];
  pathParams: string[];
  queryParams: string[];
  requestMime?: string;
  requestShape?: Shape;
  requestFields?: string[];
  responseMime?: string;
  responseShape?: Shape;
  sampleCall: number;
  score: number;
  reasons: string[];
}

export interface AuthFinding {
  type: "session-cookie" | "bearer" | "basic" | "csrf" | "api-key" | "login";
  name: string;
  detail: string;
  usedBy: number;
}

export interface Artifacts {
  curl: string;
  typescript: string;
  verify: string;
  variables: { name: string; from: string; example: string }[];
}

export interface LlmVerdict {
  used: boolean;
  model?: string;
  error?: string;
  primary: string[];
  supporting: string[];
  explanation: string;
  parameters: { endpointId: string; name: string; meaning: string }[];
  confidence: "high" | "medium" | "low";
  caveats: string[];
  nextCapture?: string;
}

export interface Report {
  meta: {
    generatedAt: string;
    entries: number;
    kept: number;
    dropped: Record<string, number>;
    hosts: string[];
    durationSeconds: number;
  };
  workflow: { description: string; inputs: string[] };
  intent: "read" | "write" | "unknown";
  selected: string[];
  endpoints: Endpoint[];
  calls: Call[];
  auth: AuthFinding[];
  artifacts: Record<string, Artifacts>;
  openapi: Record<string, unknown>;
  llm: LlmVerdict;
  warnings: string[];
}
