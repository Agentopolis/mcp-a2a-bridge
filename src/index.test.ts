import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

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
      env: { ...process.env, MOCK_A2A: 'true' },
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

  it('should successfully call the mocked a2a_send_task tool', async () => {
    const taskId = `task-${randomUUID()}`;
    const testMessage = { role: 'user', parts: [{ type: 'text', text: 'hello mock' }] };

    const result = await client.callTool({
      name: 'a2a_send_task',
      arguments: {
        taskId: taskId,
        message: testMessage,
      },
    });

    expect(result.isError).toBe(false);
    // Assert the structure of the content
    if (!Array.isArray(result.content) || result.content.length === 0 || typeof result.content[0] !== 'object' || result.content[0] === null || !('type' in result.content[0]) || !('text' in result.content[0])) {
      throw new Error('Unexpected content structure in tool result');
    }
    expect(result.content[0].type).toBe('text');
    
    // Parse the JSON string in the result text
    const responseData = JSON.parse(result.content[0].text as string);

    expect(responseData.id).toBe(taskId);
    expect(responseData.status.state).toBe('completed');
    expect(responseData.history).toEqual([testMessage]);
  });

  // We can't easily test the non-mocked error case without a real server 
  // or more complex mocking, so we leave this out for now.
  // it.todo('should return an error when calling a2a_send_task if A2A server fails');

}); 