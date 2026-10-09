import { createMcpHandler, Server } from "@modelcontextprotocol/server";

/**
 * A 2026-07-28 connector that serves one prompt and completes its argument and
 * a resource template's variable, over HTTP. `/mcp/<wsId>` tests install it to
 * check what a client outside NimbleBrain gets of a connector's prompts and
 * completions. With `completions: false` it declares no `completions`
 * capability, and lists `template` in place of `NOTE_TEMPLATE`.
 */
export const PROMPT_NAME = "greet";
export const NOTE_TEMPLATE = "notes://{id}";
const NAMES = ["Ada", "Alan", "Grace"];
const NOTE_IDS = ["101", "102", "205"];

interface PromptsConnectorOptions {
  completions?: boolean;
  template?: string;
}

function build({ completions = true, template = NOTE_TEMPLATE }: PromptsConnectorOptions): Server {
  const server = new Server(
    { name: "prompts-fixture", version: "1.0.0" },
    { capabilities: { prompts: {}, ...(completions ? { completions: {} } : {}), resources: {} } },
  );
  server.setRequestHandler("prompts/list", async () => ({
    prompts: [
      {
        name: PROMPT_NAME,
        description: "Greets someone by name.",
        arguments: [{ name: "name", description: "Who to greet.", required: true }],
      },
    ],
  }));
  server.setRequestHandler("prompts/get", async (request) => {
    if (request.params.name !== PROMPT_NAME) {
      throw new Error(`Unknown prompt: ${request.params.name}`);
    }
    const name = request.params.arguments?.name ?? "nobody";
    return {
      messages: [
        { role: "user" as const, content: { type: "text" as const, text: `Hello, ${name}.` } },
      ],
    };
  });
  if (completions) {
    server.setRequestHandler("completion/complete", async (request) => {
      const { ref, argument } = request.params;
      const pool =
        ref.type === "ref/prompt" && ref.name === PROMPT_NAME
          ? NAMES
          : ref.type === "ref/resource" && ref.uri === NOTE_TEMPLATE
            ? NOTE_IDS
            : [];
      const values = pool.filter((v) => v.startsWith(argument.value));
      return { completion: { values, total: values.length, hasMore: false } };
    });
  }
  server.setRequestHandler("resources/list", async () => ({ resources: [] }));
  server.setRequestHandler("resources/templates/list", async () => ({
    resourceTemplates: [{ uriTemplate: template, name: "note" }],
  }));
  return server;
}

/** Serve the fixture on a free port; resolves its `/mcp` URL and a stop function. */
export function servePromptsConnector(options: PromptsConnectorOptions = {}): {
  url: URL;
  stop: () => void;
} {
  const handler = createMcpHandler(() => build(options));
  const server = Bun.serve({ port: 0, fetch: (request) => handler.fetch(request) });
  return { url: new URL(`http://localhost:${server.port}/mcp`), stop: () => server.stop(true) };
}
