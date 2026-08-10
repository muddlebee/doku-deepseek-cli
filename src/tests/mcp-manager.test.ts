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

test("MCP refresh retains cached tools after a transient error and retries", async () => {
  const manager = new McpManager() as any;
  let attempts = 0;
  const server = {
    async invalidateToolsCache() {},
    async listTools() {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary JSON-RPC failure");
      return [
        {
          name: "search",
          description: "Recovered definition",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
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
        description: "Cached definition",
        inputSchema: { type: "object", properties: {} },
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
  assert.equal(manager.servers.get("test"), server);
  assert.equal(manager.getMcpToolDefinitions()[0].function.description, "Cached definition");

  await manager.refreshServerTools("test", server);
  assert.equal(manager.getMcpToolDefinitions()[0].function.description, "Recovered definition");
  assert.equal(attempts, 2);
});
