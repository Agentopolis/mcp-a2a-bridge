import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import fetch from 'node-fetch';

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

// Currently, we implement only tasks/send exposure as an MCP tool.
const A2A_BASE_URL = process.env.A2A_URL ?? 'http://localhost:7777';

interface SendTaskInput {
  taskId: string;
  message?: unknown;
}

async function callSendTask(input: SendTaskInput) {
  const { taskId, message } = input;

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
        // Cast the result to include the expected message structure for type safety
        const result = await callSendTask({ taskId, message }) as { 
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

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
}); 