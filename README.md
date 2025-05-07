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

## Installation

The bridge will be published to npm.  Until then you can run it straight from the repo:

```bash
# Clone and build
git clone https://github.com/Agentopolis/mcp-a2a-bridge.git
cd agentopolis/mcp-a2a-bridge
npm install && npm run build  

# Start the server (defaults to stdio transport)
node dist/index.js \
  --a2a-server-config-location=$HOME/.a2a-servers
```

When published:

```bash
npm install -g mcp-a2a-bridge
mcp-a2a-bridge --a2a-server-config-location=$HOME/.a2a-servers
```

### Configuration directory

The bridge remembers every A2A server you register in small JSON files.  
Location precedence:

1. `--a2a-server-config-location=/path/to/dir` CLI flag.
32. `./a2a-servers` (cwd) – default.

A typical entry lives at `<dir>/<serverId>.json`.

---

## Running in Claude / Cursor

Both editors can speak to local MCP servers over **stdio**.  Add the following to your config (example for Claude-desktop):

```jsonc
{
  "mcpServers": {
    "MCP-A2A Bridge": {
      "command": "node",
      "args": [
        "/absolute/path/to/agentopolis/mcp-a2a/dist/index.js",
        "--a2a-server-config-location=/Users/you/.a2a-servers"
      ]
    }
  }
}
```

Restart the client – the bridge appears as a new "provider".

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

1. **Register an A2A server** (replace the URL with yours):

   ```bash
   # In your MCP client prompt
   a2a_register_server {"url":"https://bella-luna-trattoria.agents.ai"}
   ```

   You should see a confirmation message.

2. **See what you have:**

   ```bash
   a2a_list_servers
   ```

3. **Invoke a skill**.  Suppose the restaurant agent exposes a skill id `provide-restaurant-info`.

   ```bash
   bella-luna-trattoria-assistant_provide-restaurant-info {"message":"Tell me about your menu"}
   ```

4. **Clean up** (optional):

   ```bash
   a2a_remove_server {"serverId":"bella-luna-trattoria-assistant"}
   ```

---

## Developer notes

* Source files:  
  * [`src/index.ts`](./src/index.ts) – CLI & MCP server wiring.  
  * [`src/registry.ts`](./src/registry.ts) – lightweight JSON-file registry.
* Build with `npm run build`; emits `dist/` for Node ≥18 (assumes built-in `fetch`).

---

Released under the MIT license.
