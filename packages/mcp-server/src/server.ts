// The MCP server both transports serve: stdio (index.ts) and the API's hosted route
// (mails-api app/api/mcp/route.ts). One factory, so the two cannot list different tools or
// answer a call differently.
//
// `tools/list` answers the tools this credential may call (toolsFor in tools.ts), by their
// `mails_…` names only. A call may also name a tool as it was named until 0.3.0 (`mails.send`):
// it is answered as that tool (toolNamed), and never listed. A call to any other tool is refused
// with an MCP error saying why (the missing scope, a test-key-only tool on a live key, …) before
// anything reaches the API; arguments that do not fit the tool's input schema come back as a
// tool error the model can correct.
import { ProtocolError, ProtocolErrorCode, Server, type CallToolResult, type Tool } from "@modelcontextprotocol/server";
import { Ajv, AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { MCP_SERVER_VERSION, SERVER_INSTRUCTIONS, callTool, definitionOf, refusal, toolNamed, toolsFor, type ToolSpec } from "./tools.ts";
import type { Credential } from "./types.ts";

export type MailsServerOptions = {
  /** The caller's API key or sign-in token, sent with every API call the tools make. */
  apiKey: string;
  baseUrl?: string;
  /** Who is calling, or how to find out (stdio asks GET /v1/me once). null: unknown, so every
   *  tool is listed and the API alone decides. */
  credential: Credential | null | (() => Promise<Credential | null>);
};

// Formats are documentation here: the API checks the values themselves, with better messages,
// so a format the validator reads more strictly than the API never refuses a good call.
const validator = new AjvJsonSchemaValidator(new Ajv({ strict: false, allErrors: true, validateFormats: false }));
const compiled = new Map<string, (input: unknown) => { valid: boolean; errorMessage?: string }>();

/** Why these arguments do not fit the tool's input schema, or undefined when they do. */
export function invalidArguments(tool: ToolSpec, args: unknown): string | undefined {
  let check = compiled.get(tool.name);
  if (!check) {
    check = validator.getValidator(tool.inputSchema as never);
    compiled.set(tool.name, check);
  }
  const r = check(args ?? {});
  return r.valid ? undefined : r.errorMessage || "they do not match the tool's input schema";
}

export function createMailsMcpServer(opts: MailsServerOptions): Server {
  const server = new Server({ name: "mails-mcp", version: MCP_SERVER_VERSION }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
  const credential = async (): Promise<Credential | null> => (typeof opts.credential === "function" ? opts.credential() : opts.credential);

  server.setRequestHandler("tools/list", async () => ({ tools: toolsFor(await credential()).map((t) => definitionOf(t) as Tool) }));

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const { name, arguments: args } = request.params;
    const tool = toolNamed(name);
    if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
    const who = await credential();
    const why = refusal(tool, who);
    if (why) throw new ProtocolError(ProtocolErrorCode.InvalidParams, why);
    const invalid = invalidArguments(tool, args);
    const result = invalid
      ? { content: [{ type: "text" as const, text: `Error: invalid arguments for ${tool.name}: ${invalid}` }], isError: true }
      : await callTool(tool.name, args ?? {}, { apiKey: opts.apiKey, baseUrl: opts.baseUrl, credential: who, signal: ctx.mcpReq.signal });
    return server.projectCallToolResult(result as CallToolResult, undefined);
  });

  return server;
}
