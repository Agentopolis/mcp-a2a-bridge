import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

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

// Currently, we implement only tasks/send exposure as an MCP tool.
const A2A_BASE_URL = process.env.A2A_URL ?? 'http://localhost:7777';

interface SendTaskInput {
  taskId: string;
  message?: unknown;
}

async function callSendTask(input: SendTaskInput) {
  const { taskId, message } = input;
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

  // Define tool for tasks/send
  server.tool(
    'a2a_send_task',
    {
      taskId: z.string(),
      message: z.unknown(),
    },
    async (args: SendTaskInput) => {
      const { taskId, message } = args;
      try {
        const result = await callSendTask({ taskId, message });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: false,
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: (err as Error).message,
            },
          ],
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