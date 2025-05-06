import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
      env: { ...process.env, A2A_URL: 'http://localhost:7778' },
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

  // TODO: Add test for calling the a2a_send_task tool
  // This will require a mock A2A server running on A2A_URL
  it.todo('should successfully call the a2a_send_task tool');

  it.todo('should return an error when calling a2a_send_task if A2A server fails');

}); 