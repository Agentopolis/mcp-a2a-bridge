import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import http from 'node:http'; // Import http module

// --- Mock A2A Server --- 
const mockA2AServerContainer: { server?: http.Server } = {}; // Use container for const
const mockA2AResponseContainer: { response?: object | null } = {}; // Use container for const
const MOCK_A2A_PORT = 7778;

function startMockA2AServer(responseType: 'success' | 'a2aError' | 'malformed') {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      let requestJson: { id?: string | number | null; params?: Record<string, unknown> } = {};
      try {
        requestJson = JSON.parse(body);
      } catch {        
        res.writeHead(400).end('Invalid JSON');
        return;
      }

      res.setHeader('Content-Type', 'application/json');
      let responsePayload: object;

      switch(responseType) {
        case 'success':
          // Simulate successful A2A task/send response (Task object)
          responsePayload = {
            jsonrpc: '2.0',
            id: requestJson?.id, // Echo back request ID
            result: { 
              id: requestJson?.params?.id || 'unknown-task',
              sessionId: 'real-a2a-session-id',
              status: {
                state: 'completed',
                timestamp: new Date().toISOString(),
                message: { 
                  role: 'agent', 
                  parts: [{ type: 'text', text: `A2A server processed: ${requestJson?.params?.id}` }]
                }
              },
              history: requestJson?.params?.message ? [requestJson.params.message] : [],
              artifacts: []
            }
          };
          break;
        case 'a2aError':
          responsePayload = {
            jsonrpc: '2.0',
            id: requestJson?.id,
            error: { code: -32001, message: 'A2A Task Not Found Error' }
          };
          break;
        case 'malformed': // Send non-JSON response
           res.setHeader('Content-Type', 'text/plain');
           res.writeHead(200).end('This is not JSON');
           return;
      }
      res.writeHead(200).end(JSON.stringify(responsePayload));
    });
  });
  mockA2AServerContainer.server = server; // Store in container
  return new Promise<void>((resolve) => {
    server.listen(MOCK_A2A_PORT, resolve);
  });
}

function stopMockA2AServer() {
  return new Promise<void>((resolve, reject) => {
    const server = mockA2AServerContainer.server;
    if (server?.listening) { // Use optional chaining
      server.close((err) => {
        if (err) return reject(err);
        resolve();
      });
    } else {
      resolve();
    }
  });
}
// --- End Mock A2A Server --- 

// Helper to get base directory
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..'); // Adjust if test file moves

describe('MCP-A2A Bridge Server via Stdio', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    // Setup client - let the transport manage the server process
    transport = new StdioClientTransport({
      command: 'node',
      args: [path.join(projectRoot, 'dist', 'index.js')],
      cwd: projectRoot,
      env: { ...process.env, A2A_URL: `http://localhost:${MOCK_A2A_PORT}` }, // Use A2A_URL for non-mock tests
    });

    client = new Client({
      name: 'test-client',
      version: '1.0.0',
    });

    try {
      await client.connect(transport);
    } catch (error) {
      console.error("Client connection failed:", error);
      // Transport should handle process cleanup on connection error or close
      throw error; // Re-throw error to fail the test setup
    }
  }, 15000); // Increase timeout for setup

  afterAll(async () => {
    await client?.close(); // Use close() instead of disconnect()
    // Transport handles closing the process when client.close() is called
  });

  it('should list the a2a_send_task tool', async () => {
    const toolsResponse = await client.listTools();
    expect(toolsResponse).toBeDefined();
    expect(toolsResponse.tools).toBeInstanceOf(Array);
    
    const sendTool = toolsResponse.tools.find(t => t.name === 'a2a_send_task');
    expect(sendTool).toBeDefined();
    expect(sendTool?.description).toBeUndefined(); // No description provided yet
    expect(sendTool?.inputSchema).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        message: {},
      },
      required: ['taskId'],
      additionalProperties: false,
    });
  });

  // --- Non-Mocked Tests ---
  describe('Non-Mocked A2A Calls', () => {

    afterEach(async () => {
      await stopMockA2AServer(); // Ensure mock server stops after each test
    });

    it('should successfully call a2a_send_task tool via mock A2A server', async () => {
      await startMockA2AServer('success'); // Start mock server for success response

      const taskId = `task-${randomUUID()}`;
      const testMessage = { role: 'user', parts: [{ type: 'text', text: 'hello real deal' }] };

      const result = await client.callTool({
        name: 'a2a_send_task',
        arguments: {
          taskId: taskId,
          message: testMessage,
        },
      });

      expect(result.isError).toBe(false);
      if (!Array.isArray(result.content) || result.content.length === 0 || typeof result.content[0] !== 'object' || result.content[0] === null || !('type' in result.content[0]) || !('text' in result.content[0])) {
        throw new Error('Unexpected content structure in tool result');
      }
      expect(result.content[0].type).toBe('text');
      // Check the text returned by the mock A2A success response
      expect(result.content[0].text).toBe(`A2A server processed: ${taskId}`);
    });

    it('should return network error when A2A server is down', async () => {
      // Ensure mock server is NOT running
      await stopMockA2AServer(); 

      const taskId = `task-${randomUUID()}`;
      const result = await client.callTool({
        name: 'a2a_send_task',
        arguments: { taskId },
      });

      expect(result.isError).toBe(true);
      if (!Array.isArray(result.content) || result.content.length === 0 || typeof result.content[0] !== 'object' || result.content[0] === null || !('type' in result.content[0]) || !('text' in result.content[0])) {
        throw new Error('Unexpected content structure in tool result');
      }
      expect(result.content[0].type).toBe('text');
      // Log the exact text content being asserted
      console.log('[TEST DEBUG] Received error text:', JSON.stringify(result.content[0].text));
      // Accept either ECONNREFUSED or ECONNRESET depending on how the OS surfaces a closed port
      expect(result.content[0].text).toMatch(/A2A fetch failed\. Code: (ECONNREFUSED|ECONNRESET)/);
    });

    it('should return A2A error when mock A2A server returns error', async () => {
      await startMockA2AServer('a2aError'); // Start mock server for error response

      const taskId = `task-${randomUUID()}`;
      const result = await client.callTool({
        name: 'a2a_send_task',
        arguments: { taskId },
      });

      expect(result.isError).toBe(true);
      if (!Array.isArray(result.content) || result.content.length === 0 || typeof result.content[0] !== 'object' || result.content[0] === null || !('type' in result.content[0]) || !('text' in result.content[0])) {
        throw new Error('Unexpected content structure in tool result');
      }
      expect(result.content[0].type).toBe('text');
      // Check for the specific A2A error message
      expect(result.content[0].text).toBe('A2A Task Not Found Error');
    });

  }); // End describe Non-Mocked

}); 