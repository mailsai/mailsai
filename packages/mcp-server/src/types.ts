// Shapes shared by the hand-written tools (tools.ts), the generated ones (generated/tools.ts,
// written by scripts/gen-mcp-tools.ts from the API's OpenAPI document) and the two transports
// (index.ts over stdio, the API's app/api/mcp/route.ts over HTTP).

/** A tool's input: plain JSON Schema with an object at the root, as MCP requires. */
export type InputSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [keyword: string]: unknown;
};

/** The hints the Claude and ChatGPT directories read. All four are set on every tool, so no
 *  client has to guess at a default. */
export type ToolHints = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

/** What `tools/list` sends for one tool. */
export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: InputSchema;
  annotations: ToolHints & { title: string };
};

/** What a credential needs before an API route will answer it. Generated from the OpenAPI
 *  document and from the route files themselves, never typed by hand. */
export type RouteFacts = {
  /** The scope a credential must hold. Absent: any valid credential. */
  scope?: string;
  /** Every scope that opens the route, when more than one does (`x-accepted-scopes`: the draft
   *  routes take `draft` as well): holding any one of them is enough. */
  acceptedScopes?: string[];
  /** Further scopes the route requires besides `scope`, read from its own `requireScope` calls: a
   *  credential needs every one (PATCH /v1/messages/{id} takes `send` beside `manage`). */
  alsoNeeds?: string[];
  /** Answers only a test key. */
  testKeyOnly?: boolean;
  /** Refuses every test key (`live_mode_required`): the route sends a real email. `message` is
   *  the route's own. */
  liveKeyOnly?: { message: string };
  /** Needs no credential at all. */
  noAuth?: boolean;
  /** Refused for an app someone connected by signing in (anything but the mails CLI):
   *  `always`, or `partly` when only some changes are refused. `message` is the route's own. */
  connectedApps?: { refused: "always" | "partly"; message: string };
  /** Refused for a key tied to one agent. `why` finishes "This API key is tied to one agent,
   *  and …", in the route's own words. `partly` when the route answers some of that key's
   *  requests before it refuses (GET /v1/suppression answers `address` and `view=suppressed`):
   *  the tool is then shown, and the API decides. */
  agentKeys?: { why: string; refused?: "partly" };
};

export type ArgTarget = { in: "path" | "query" | "header" | "body"; key: string };

/** One generated tool: its definition plus how its arguments become one HTTP call. */
export type GeneratedTool = ToolDefinition & {
  /** Heading it is listed under in the README and the dashboard. */
  group: string;
  /** `METHOD /v1/path/{}`, the key into ROUTE_FACTS. */
  route: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The documented path, with `{name}` placeholders. */
  path: string;
  /** Argument name → where it goes. */
  args: Record<string, ArgTarget>;
  /** The whole JSON body is this one argument (an array body, such as a batch send). */
  bodyArg?: string;
  /** The operation takes a JSON body (sent as `{}` when no body argument is given). */
  sendsBody: boolean;
  response: "json" | "text" | "binary" | "empty";
  /** The operation honours an Idempotency-Key header: one is sent on every call, so a retry
   *  after a dropped connection can never act twice. */
  idempotencyKey: boolean;
  /** The API holds the call open for up to `arg` seconds (`defaultSeconds` when it is absent)
   *  before it answers, a long poll: the call gets that long and a margin instead of the usual
   *  30 seconds, and is sent once, since a resend would start the wait over. */
  longPoll?: { arg: string; defaultSeconds: number };
};

/** Who is calling, as far as the tool list cares. */
export type Credential = {
  scopes: string[];
  mode: "live" | "test";
  /** Set for a key tied to one agent. */
  agentId: string | null;
  /** An app somebody connected by signing in (Claude, ChatGPT, Cursor…), not the mails CLI. */
  connectedApp: boolean;
};

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export type ToolResult = { content: ToolContent[]; isError?: boolean };
