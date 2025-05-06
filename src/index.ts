import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import fetch from 'node-fetch';
import { A2ARegistry } from './registry.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { RegisteredServer } from './registry.js';

console.error(`[DEBUG] Node version: ${process.versions.node}`);
console.error(`[DEBUG] Type of fetch: ${typeof fetch}`);

// Node 18+ includes global `fetch` so no additional dependency needed.

// -----------------------------
// Basic types from the A2A spec
// -----------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// Utility to send JSON-RPC calls to an A2A agent running at a particular baseUrl
async function sendA2ARequest(
  baseUrl: URL,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(`A2A HTTP error: ${response.status}`);
  }
  return (await response.json()) as JsonRpcResponse;
}

// -----------------------------
// Minimal bridging implementation
// -----------------------------

// Check if we should mock A2A calls
const MOCK_A2A_CALLS = process.env.MOCK_A2A === 'true';

// -----------------------------------
// CLI parsing for registry directory
// -----------------------------------

const argv = yargs(hideBin(process.argv))
  .option('a2a-server-config-location', {
    type: 'string',
    describe: 'Directory path where A2A server registrations are stored',
  })
  .parseSync();

const REGISTRY_DIR = (argv['a2a-server-config-location'] as string) || process.env.A2A_SERVER_CONFIG_LOCATION || './a2a-servers';

// Initialize registry (will create dir if missing)
const registry = new A2ARegistry(REGISTRY_DIR);
await registry.init();

// -----------------------------
// Currently, we implement only tasks/send exposure as an MCP tool.
// -----------------------------

interface SendTaskInput {
  taskId: string;
  message?: unknown;
}

async function callSendTask(input: SendTaskInput & { serverId: string }) {
  const { taskId, message, serverId } = input;

  // Lookup server in registry
  const serverEntry = await registry.get(serverId);
  if (!serverEntry) {
    throw new Error(`Unknown A2A server id: ${serverId}. Register it first.`);
  }

  const A2A_BASE_URL = serverEntry.card.url;

  // --- Mocking Logic --- 
  if (MOCK_A2A_CALLS) {
    console.error('[MOCK] Returning mock success for tasks/send');
    // Simulate a successful A2A response structure
    // Based on A2A spec, `tasks/send` returns the Task object
    return {
      // task object structure based on a2a.json schema
      id: taskId,
      sessionId: 'mock-session-id', // Example session ID
      status: {
        state: 'completed',
        timestamp: new Date().toISOString(),
        message: {
          role: 'agent',
          parts: [{ type: 'text', text: `Mock agent acknowledges task: ${taskId}` }]
        }
      },
      history: [
        message 
      ],
      artifacts: [] // No artifacts in this mock
    };
  }
  // --- End Mocking Logic ---

  const req: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: randomUUID(),
    method: 'tasks/send',
    params: {
      id: taskId,
      message,
    },
  };
  const resp = await sendA2ARequest(new URL(A2A_BASE_URL), req);
  if (resp.error) {
    throw new Error(resp.error.message);
  }
  return resp.result;
}

// Helper slugify (same logic as registry)
function slugify(text: string): string {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

// Set to track which dynamic tools have already been registered to avoid duplicates
const dynamicToolNames = new Set<string>();

function makeSkillToolName(serverId: string, skillId: string): string {
  return `${slugify(serverId)}_${slugify(skillId)}`;
}

// Async helper to register skill tools based on current registry entries
async function registerSkillTools(mcpServerInstance: McpServer): Promise<number> {
  const servers: RegisteredServer[] = await registry.list();
  let countAdded = 0;

  for (const srv of servers) {
    for (const skill of (srv.card.skills ?? []) as { id: string; name?: string; description?: string }[]) {
      const toolName = makeSkillToolName(srv.id, skill.id);
      if (dynamicToolNames.has(toolName)) continue; // Already registered

      mcpServerInstance.tool(
        toolName,
        skill.description ?? `Invoke skill ${skill.id} on agent ${srv.card.name}`,
        { message: z.string() },
        async (args: { message: string }) => {
          try {
            const taskMessage = {
              role: 'user',
              parts: [{ type: 'text', text: args.message }],
            };
            const result = (await callSendTask({
              serverId: srv.id,
              taskId: randomUUID(),
              message: taskMessage,
            })) as { status?: { message?: { parts?: { type: string; text: string }[] } } };

            const agentReplyParts: { type: 'text'; text: string }[] =
              result?.status?.message?.parts?.map((part) => ({ type: 'text' as const, text: part.text })) ?? [
                { type: 'text', text: 'No reply received.' },
              ];

            return {
              content: agentReplyParts,
              isError: false,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: 'text', text: msg }],
              isError: true,
            };
          }
        },
      );
      dynamicToolNames.add(toolName);
      countAdded += 1;
    }
  }

  return countAdded;
}

// -----------------------------
// MCP server setup
// -----------------------------

async function main() {
  const server = new McpServer(
    {
      name: 'mcp-a2a-bridge',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Dynamically register tools for existing skills
  await registerSkillTools(server);

  // Define tool for tasks/send
  server.tool(
    'a2a_send_task',
    {
      serverId: z.string(),
      taskId: z.string(),
      message: z.unknown().optional(),
    },
    async (args: SendTaskInput & { serverId: string }) => {
      const { taskId, message, serverId } = args;
      try {
        // Cast the result to include the expected message structure for type safety
        const result = await callSendTask({ serverId, taskId, message }) as { 
          status?: { message?: { parts?: {type: string; text: string}[] } }
          // Include other expected Task fields if needed for typing
        };

        // Extract the agent's reply parts from the result, default to generic message
        const agentReplyParts: { type: 'text'; text: string }[] = (result?.status?.message?.parts?.map(part => ({ 
          type: 'text' as const, // Ensure type is literally 'text'
          text: part.text 
        })) || [
          { type: 'text', text: 'Mock task completed (no specific agent reply)' }
        ]);

        return {
          content: agentReplyParts, // Use the extracted parts directly
          isError: false,
        };
      } catch (err) {
        console.error('[DEBUG] Caught fetch error in tool:', err);
 
        let errorMessage = 'An unknown error occurred during A2A call.';
        if (err instanceof Error) {
          // Check if it's a system error with a code (like FetchError)
          if ('code' in err && typeof err.code === 'string') {
            errorMessage = `A2A fetch failed. Code: ${err.code}`;
          } else {
            // Otherwise, use the standard error message (like our thrown A2A errors)
            errorMessage = err.message;
          }
        } else {
          errorMessage = String(err); // Fallback for non-Error objects
        }
 
        return {
          content: [
            {
              type: 'text',
              text: errorMessage,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Tool to register new A2A server
  server.tool(
    'a2a_register_server',
    {
      url: z.string().url(),
    },
    async ({ url }: { url: string }) => {
      try {
        const entry = await registry.register(url);
        return {
          content: [
            { type: 'text', text: `Registered A2A server ${entry.card.name ?? entry.id}` },
          ],
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: msg }],
          isError: true,
        };
      }
    },
  );

  // Tool to reload A2A server configurations from disk
  server.tool(
    'a2a_reload_servers',
    'Rescans the configuration directory and reloads all A2A server definitions into memory.', // Description string
    // No input schema for tools that take no arguments
    async (_extra: unknown) => { // Callback takes only 'extra', args are omitted
      try {
        const { count } = await registry.reloadServers();
        return {
          content: [
            {
              type: 'text',
              text: `Successfully reloaded A2A server configurations. Found ${count} servers.`,
            },
          ],
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[DEBUG] Error reloading A2A server configurations:', err);
        return {
          content: [{ type: 'text', text: `Failed to reload A2A servers: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // Tool to list registered A2A servers
  server.tool(
    'a2a_list_servers',
    'Lists all registered A2A servers with their IDs and names.',
    async (_extra: unknown) => {
      try {
        const servers = await registry.list();
        const serverSummaries = servers.map(s => ({ id: s.id, name: s.card.name, registrationUrl: s.registrationUrl }));
        return {
          content: [
            {
              type: 'text',
              text: `Found ${serverSummaries.length} registered A2A servers:\n${JSON.stringify(serverSummaries, null, 2)}`,
            },
          ],
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[DEBUG] Error listing A2A servers:', err);
        return {
          content: [{ type: 'text', text: `Failed to list A2A servers: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // Tool to get details of a specific A2A server
  server.tool(
    'a2a_get_server_details',
    'Retrieves the full registration details for a specific A2A server by its ID.',
    { serverId: z.string() },
    async (args, _extra: unknown) => {
      try {
        const serverDetails = await registry.get(args.serverId);
        if (!serverDetails) {
          return {
            content: [
              {
                type: 'text',
                text: `A2A server with ID "${args.serverId}" not found.`,
              },
            ],
            isError: true, // Indicate it's an error, but a "not found" one
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: `Details for A2A server "${args.serverId}":\n${JSON.stringify(serverDetails, null, 2)}`,
            },
          ],
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[DEBUG] Error getting A2A server details for ID "${args.serverId}":`, err);
        return {
          content: [{ type: 'text', text: `Failed to get A2A server details: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // Tool to remove an A2A server registration
  server.tool(
    'a2a_remove_server',
    'Removes an A2A server registration from the MCP server by its ID.',
    { serverId: z.string() }, // ZodRawShape for input
    async (args: { serverId: string }, _extra: unknown) => {
      try {
        const success = await registry.remove(args.serverId);
        if (success) {
          return {
            content: [
              {
                type: 'text',
                text: `A2A server with ID "${args.serverId}" successfully removed.`,
              },
            ],
            isError: false,
          };
        } 
        // If not successful, return the failure message
        return {
          content: [
            {
              type: 'text',
              text: `Failed to remove A2A server with ID "${args.serverId}". It might not exist or an error occurred.`,
            },
          ],
          isError: true, // Indicate failure to remove
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[DEBUG] Error removing A2A server ID "${args.serverId}":`, err);
        return {
          content: [{ type: 'text', text: `Error processing removal of A2A server: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
}); 