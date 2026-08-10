import { test } from "node:test";
import assert from "node:assert/strict";
import { McpManager } from "../mcp/mcp-manager";

test("MCP refresh replaces a same-name tool when its schema changes", async () => {
  const manager = new McpManager() as any;
  const server = {
    async invalidateToolsCache() {},
    async listTools() {
      return [
        {
          name: "search",
          description: "New description",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" }, limit: { type: "number" } },
          },
        },
      ];
    },
  };
  manager.servers.set("test", server);
  manager.tools = [
    {
      serverName: "test",
      originalName: "search",
      namespacedName: "mcp__test__search",
      definition: {
        name: "search",
        description: "Old description",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
      server,
    },
  ];
  manager.serverStatuses = [
    {
      name: "test",
      status: "ready",
      connected: true,
      toolCount: 1,
      tools: ["mcp__test__search"],
      promptCount: 0,
      prompts: [],
      resourceCount: 0,
      resources: [],
    },
  ];

  await manager.refreshServerTools("test", server);

  const [definition] = manager.getMcpToolDefinitions();
  assert.equal(definition.function.description, "New description");
  assert.deepEqual(definition.function.parameters.properties, {
    query: { type: "string" },
    limit: { type: "number" },
  });
});
