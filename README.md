# MCP-A2A Bridge

> A lightweight Model Context Protocol (MCP) **server** that proxies requests to one or more remote **A2A** agents.
>
> It lets tools that natively speak MCP – such as Claude, Cursor AI, or any other MCP-aware client – interact with agents that expose the [A2A protocol](https://github.com/modelcontextprotocol/a2a).  
> In short: **MCP on the front-end, A2A on the back-end.**

---

## Why would I want this?

* **Unifies protocols.**  If your favourite client only knows MCP but your agents speak A2A, the bridge glues them together.
* **No code changes on either side.**  A2A agents remain unchanged, while MCP clients see a normal MCP tool catalogue.
* **Dynamic.**  Register new A2A servers at runtime and the bridge instantly exposes every skill on those agents as callable MCP tools.

---

## Installation & Usage

There are a couple of ways to run the MCP-A2A Bridge:

**1. From Source (e.g., for development):**

```bash
# Clone and build the repository
git clone https://github.com/Agentopolis/mcp-a2a-bridge.git
cd mcp-a2a-bridge
npm install && npm run build

# Start the server (defaults to stdio transport)
node dist/index.js \
  --a2a-server-config-dir=$HOME/.config/mcp-a2a-bridge/servers
```

**2. Using NPX (once published to npm):**

This allows you to run the bridge without a global installation. `npx` will download the latest version if needed.

```bash
npx @agentopolis/mcp-a2a-bridge --a2a-server-config-dir=$HOME/.config/mcp-a2a-bridge/servers
```

**3. Global Installation (once published to npm):**

This installs the `mcp-a2a-bridge` command globally on your system.

```bash
npm install -g @agentopolis/mcp-a2a-bridge

# Then run it:
mcp-a2a-bridge --a2a-server-config-dir=$HOME/.config/mcp-a2a-bridge/servers
```

### Configuration Directory

The bridge remembers every A2A server you register in small JSON files.  
Location precedence for this directory is:

1. `--a2a-server-config-dir=/path/to/your/config/dir` (CLI flag)
2. `./.mcp-a2a-servers` (Relative to current working directory – default if the CLI flag is not set)

A typical entry lives at `<config_dir>/<serverId>.json`.
It's recommended to use a dedicated directory like `$HOME/.config/mcp-a2a-bridge/servers` via the CLI flag.

---

## Running in Claude / Cursor

Both editors can speak to local MCP servers over **stdio**.  Add the following to your client's configuration (example for Claude Desktop, adjust paths as necessary):

```jsonc
{
  "mcpServers": {
    "MCP-A2A Bridge": {
      "command": "node", // Or 'mcp-a2a-bridge' if globally installed and in PATH
      "args": [
        // If running from source or npx without global install:
        "/absolute/path/to/mcp-a2a-bridge/dist/index.js", 
        // If globally installed, this arg might not be needed if 'mcp-a2a-bridge' is the command
        "--a2a-server-config-dir=/Users/you/.config/mcp-a2a-bridge/servers"
      ]
      // "env": { "A2A_SERVER_CONFIG_LOCATION": "/Users/you/.config/mcp-a2a-bridge/servers" } // Alternative for config (REMOVED)
    }
  }
}
```

Restart the client – the bridge should appear as a new tool provider.

---

## Available MCP tools

| Tool name | Purpose | Input schema |
|-----------|---------|-------------|
| `a2a_register_server` | Fetches an A2A agent's card from `<url>/.well-known/agent.json` and saves it. | `{ url: string }` |
| `a2a_reload_servers`  | Re-reads all JSON files in the config directory. | _none_ |
| `a2a_list_servers`    | Lists registered servers. | _none_ |
| `a2a_get_server_details` | Full card for a given server. | `{ serverId: string }` |
| `a2a_remove_server`   | Delete a registration. | `{ serverId: string }` |
| `a2a_send_task`       | Generic escape hatch – call any A2A agent with an arbitrary message. | `{ serverId: string; taskId: string; message?: string | Message }` |
| _`<serverId>_<skillId>`_ | **Auto-generated**. One tool per skill on every registered agent. Accepts `{ message: string }`. | — |

> A `<serverId>_<skillId>` tool name is slugified (`my-agent` + `provide-restaurant-info` → `my-agent_provide-restaurant-info`).

---

## Quickstart walkthrough

1. **Ensure the bridge is running** using one of the methods above.
2. **Register an A2A server** (replace the URL with yours) via your MCP client (e.g., Claude, Cursor):

   ```json
   // Tool call in your MCP client
   {"tool_name": "a2a_register_server", "parameters": {"url":"https://bella-luna-trattoria.agents.ai"}}
   ```

   You should see a confirmation message from the bridge.

3. **See what you have:**

   ```json
   // Tool call in your MCP client
   {"tool_name": "a2a_list_servers", "parameters": {}}
   ```

4. **Invoke a skill**.  Suppose the restaurant agent (`bella-luna-trattoria-assistant`) exposes a skill id `provide-restaurant-info`.

   ```json
   // Tool call in your MCP client
   {"tool_name": "bella-luna-trattoria-assistant_provide-restaurant-info", "parameters": {"message":"Tell me about your menu"}}
   ```

5. **Clean up** (optional):

   ```json
   // Tool call in your MCP client
   {"tool_name": "a2a_remove_server", "parameters": {"serverId":"bella-luna-trattoria-assistant"}}
   ```

---

## Developer notes

* Source files are in the `src/` directory relative to the `mcp-a2a-bridge` project root:  
  * [`src/index.ts`](./src/index.ts) – CLI & MCP server wiring.  
  * [`src/registry.ts`](./src/registry.ts) – lightweight JSON-file registry.
* Build with `npm run build`; emits JavaScript to `dist/` (targets Node ≥18, assumes built-in `fetch`).
* For local development, you can use `npm run dev` to run with `ts-node`.
* Set the environment variable `MOCK_A2A=true` to stub all outgoing HTTP calls to A2A servers (useful for offline testing or UI development).

---

Released under the MIT license.
