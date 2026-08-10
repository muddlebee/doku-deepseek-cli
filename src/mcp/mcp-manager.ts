import { MCPServerStdio, type MCPResource, type MCPServerWithResources } from "@openai/agents";
import * as path from "node:path";
import type { McpServerConfig } from "../settings";

const parsedStartupTimeout = process.env.DOKU_MCP_TIMEOUT ? Number.parseInt(process.env.DOKU_MCP_TIMEOUT, 10) : 30_000;
const MCP_STARTUP_TIMEOUT_MS = Number.isFinite(parsedStartupTimeout) ? parsedStartupTimeout : 30_000;
const MCP_CALL_TOOL_TIMEOUT_MS = 60_000;
const MCP_TOOL_REFRESH_INTERVAL_MS = 1_000;

type McpToolEntry = {
  serverName: string;
  originalName: string;
  namespacedName: string;
  definition: SdkMcpTool;
  server: MCPServerStdio;
};

type SdkMcpTool = Awaited<ReturnType<MCPServerStdio["listTools"]>>[number];

type McpResourceEntry = {
  serverName: string;
  namespacedName: string;
  definition: MCPResource;
  server: MCPServerWithResources;
};

type McpPromptDefinition = {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

type McpPromptEntry = {
  serverName: string;
  namespacedName: string;
  definition: McpPromptDefinition;
  server: MCPServerStdio;
};

type McpPromptClient = {
  listPrompts(params?: { cursor?: string }): Promise<{ prompts: McpPromptDefinition[]; nextCursor?: string }>;
  getPrompt(params: { name: string; arguments?: Record<string, string> }): Promise<{
    messages: Array<{ role: string; content: { type: string; text?: string } }>;
    [key: string]: unknown;
  }>;
};

type SdkTransport = {
  onclose?: () => void;
};

type SdkServerInternals = {
  underlying?: {
    transport?: SdkTransport | null;
    session?: McpPromptClient | null;
  };
};

export type McpServerStatus = {
  name: string;
  status: "starting" | "ready" | "failed" | "reconnecting";
  connected: boolean;
  error?: string;
  toolCount: number;
  tools: string[];
  promptCount: number;
  prompts: string[];
  resourceCount: number;
  resources: string[];
};

export class McpManager {
  private readonly servers = new Map<string, MCPServerStdio>();
  private tools: McpToolEntry[] = [];
  private prompts: McpPromptEntry[] = [];
  private resources: McpResourceEntry[] = [];
  private initialized = false;
  private disposed = false;
  private configuredServerNames: string[] = [];
  private serverStatuses: McpServerStatus[] = [];
  private onToolsListChanged: (() => void) | null = null;
  private onStatusChanged: (() => void) | null = null;
  private serverConfigs: Record<string, McpServerConfig> = {};
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly refreshingServers = new Set<string>();
  private readonly intentionallyClosing = new Set<string>();

  prepare(servers?: Record<string, McpServerConfig>): void {
    if (!servers || Object.keys(servers).length === 0) return;
    this.disposed = false;
    for (const name of Object.keys(servers)) {
      if (!this.configuredServerNames.includes(name)) this.configuredServerNames.push(name);
      if (this.serverStatuses.some((status) => status.name === name)) continue;
      this.setStatus(this.emptyStatus(name, "starting"));
    }
  }

  async initialize(servers?: Record<string, McpServerConfig>): Promise<void> {
    if (this.initialized || this.disposed) return;
    this.initialized = true;
    if (!servers || Object.keys(servers).length === 0) return;
    this.serverConfigs = { ...servers };
    this.prepare(servers);
    for (const [name, config] of Object.entries(servers)) {
      if (this.disposed) break;
      await this.connectServer(name, config);
    }
    this.startRefreshTimer();
  }

  async reconnect(name: string, config?: McpServerConfig): Promise<void> {
    if (this.disposed) return;
    const effectiveConfig = config ?? this.serverConfigs[name];
    if (!effectiveConfig) return;
    this.serverConfigs[name] = effectiveConfig;
    this.setStatus({ ...this.emptyStatus(name, "reconnecting"), error: "Reconnecting..." });
    await this.closeServer(name);
    await this.connectServer(name, effectiveConfig);
    this.startRefreshTimer();
  }

  getStatus(): McpServerStatus[] {
    const statuses = this.serverStatuses.map((status) => ({ ...status }));
    const knownNames = new Set(statuses.map((status) => status.name));
    for (const name of this.configuredServerNames) {
      if (!knownNames.has(name)) statuses.push(this.emptyStatus(name, "starting"));
    }
    return statuses;
  }

  getMcpToolDefinitions(): Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
    };
  }> {
    return this.tools.map((entry) => {
      const schema = this.normalizeInputSchema(entry.definition.inputSchema);
      return {
        type: "function" as const,
        function: {
          name: entry.namespacedName,
          description: entry.definition.description ?? `${entry.serverName}: ${entry.originalName}`,
          parameters: schema,
        },
      };
    });
  }

  isMcpTool(name: string): boolean {
    return name.startsWith("mcp__");
  }

  async executeMcpTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = MCP_CALL_TOOL_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; name: string; output?: string; error?: string }> {
    const tool = this.tools.find((entry) => entry.namespacedName === name);
    if (!tool) return { ok: false, name, error: `Unknown MCP tool: ${name}` };

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`MCP tool call timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    try {
      const result = await tool.server.callToolResult(tool.originalName, args, null, {
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      const text = result.content
        .filter((content) => content.type === "text" && "text" in content)
        .map((content) => ("text" in content && typeof content.text === "string" ? content.text : ""))
        .join("\n");
      return {
        ok: !result.isError,
        name,
        output: text || JSON.stringify(result.structuredContent ?? result.content),
      };
    } catch (error) {
      if (!this.disposed && this.isConnectionError(error)) this.markServerFailed(tool.serverName, error);
      return { ok: false, name, error: this.errorMessage(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  async getMcpPrompt(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; name: string; output?: string; error?: string }> {
    const prompt = this.prompts.find((entry) => entry.namespacedName === name);
    if (!prompt) return { ok: false, name, error: `Unknown MCP prompt: ${name}` };
    const client = this.getPromptClient(prompt.server);
    if (!client) return { ok: false, name, error: `MCP prompt transport is unavailable: ${name}` };
    try {
      const result = await client.getPrompt({
        name: prompt.definition.name,
        arguments: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)])),
      });
      const text = result.messages
        .filter((message) => message.content.type === "text" && typeof message.content.text === "string")
        .map((message) => `[${message.role}] ${message.content.text}`)
        .join("\n");
      return { ok: true, name, output: text || JSON.stringify(result) };
    } catch (error) {
      if (!this.disposed && this.isConnectionError(error)) this.markServerFailed(prompt.serverName, error);
      return { ok: false, name, error: this.errorMessage(error) };
    }
  }

  async readMcpResource(
    name: string,
    uri: string
  ): Promise<{ ok: boolean; name: string; output?: string; error?: string }> {
    const resource = this.resources.find((entry) => entry.namespacedName === name);
    if (!resource) return { ok: false, name, error: `Unknown MCP resource: ${name}` };
    try {
      const result = await resource.server.readResource(uri);
      const text = result.contents
        .filter((content): content is Extract<(typeof result.contents)[number], { text: string }> => "text" in content)
        .map((content) => content.text)
        .join("\n");
      return { ok: true, name, output: text || JSON.stringify(result.contents) };
    } catch (error) {
      if (!this.disposed && this.isConnectionError(error)) this.markServerFailed(resource.serverName, error);
      return { ok: false, name, error: this.errorMessage(error) };
    }
  }

  disconnect(): void {
    this.disposed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    const servers = [...this.servers.entries()];
    this.servers.clear();
    for (const [name, server] of servers) {
      this.intentionallyClosing.add(name);
      void server.close().finally(() => this.intentionallyClosing.delete(name));
    }
    this.tools = [];
    this.prompts = [];
    this.resources = [];
    this.serverStatuses = [];
    this.configuredServerNames = [];
    this.serverConfigs = {};
    this.initialized = false;
  }

  setOnToolsListChanged(handler: () => void): void {
    this.onToolsListChanged = handler;
  }

  setOnStatusChanged(handler: () => void): void {
    this.onStatusChanged = handler;
  }

  private async connectServer(name: string, config: McpServerConfig): Promise<void> {
    if (this.disposed) return;
    this.removeServerEntries(name);
    const server = new MCPServerStdio({
      name,
      command: config.command,
      args: this.withNpxYesArg(config.command, config.args ?? []),
      env: this.mergeEnvironment(config.env),
      cacheToolsList: false,
      clientSessionTimeoutSeconds: Math.max(1, Math.ceil(MCP_STARTUP_TIMEOUT_MS / 1000)),
      timeout: MCP_CALL_TOOL_TIMEOUT_MS,
    });
    try {
      await this.withTimeout(server.connect(), MCP_STARTUP_TIMEOUT_MS, `starting MCP server "${name}"`);
      if (this.disposed) {
        await server.close();
        return;
      }
      this.servers.set(name, server);
      this.attachCloseMonitor(name, server);
      const serverTools = await this.withTimeout(
        server.listTools(),
        MCP_STARTUP_TIMEOUT_MS,
        `listing tools for "${name}"`
      );
      const serverResources = await this.listAllResources(server);
      const serverPrompts = await this.listAllPrompts(server);
      if (this.disposed || this.servers.get(name) !== server) return;
      this.replaceServerTools(name, server, serverTools);
      this.replaceServerResources(name, server, serverResources);
      this.replaceServerPrompts(name, server, serverPrompts);
      this.setStatus({
        name,
        status: "ready",
        connected: true,
        toolCount: serverTools.length,
        tools: serverTools.map((tool) => `mcp__${name}__${tool.name}`),
        promptCount: serverPrompts.length,
        prompts: serverPrompts.map((prompt) => `mcp__${name}__${prompt.name}`),
        resourceCount: serverResources.length,
        resources: serverResources.map((resource) => `mcp__${name}__${resource.name ?? resource.uri}`),
      });
    } catch (error) {
      this.intentionallyClosing.add(name);
      await server.close().catch(() => {});
      this.intentionallyClosing.delete(name);
      if (!this.disposed) this.markServerFailed(name, error);
    }
  }

  private async listAllResources(server: MCPServerWithResources): Promise<MCPResource[]> {
    const resources: MCPResource[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      try {
        const result = await this.withTimeout(
          server.listResources(cursor ? { cursor } : undefined),
          MCP_STARTUP_TIMEOUT_MS,
          `listing resources for "${server.name}"`
        );
        resources.push(...result.resources);
        cursor = result.nextCursor;
        if (!cursor) return resources;
      } catch (error) {
        if (page === 0 && !this.isConnectionError(error)) return [];
        throw error;
      }
    }
    throw new Error(`MCP server "${server.name}" returned too many resources/list pages`);
  }

  private async listAllPrompts(server: MCPServerStdio): Promise<McpPromptDefinition[]> {
    const client = this.getPromptClient(server);
    if (!client) return [];
    const prompts: McpPromptDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      try {
        const result = await this.withTimeout(
          client.listPrompts(cursor ? { cursor } : undefined),
          MCP_STARTUP_TIMEOUT_MS,
          `listing prompts for "${server.name}"`
        );
        prompts.push(...result.prompts);
        cursor = result.nextCursor;
        if (!cursor) return prompts;
      } catch (error) {
        if (page === 0 && !this.isConnectionError(error)) return [];
        throw error;
      }
    }
    throw new Error(`MCP server "${server.name}" returned too many prompts/list pages`);
  }

  private startRefreshTimer(): void {
    if (this.refreshTimer || this.disposed || this.servers.size === 0) return;
    this.refreshTimer = setInterval(() => {
      for (const [name, server] of this.servers) void this.refreshServerTools(name, server);
    }, MCP_TOOL_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref();
  }

  private async refreshServerTools(name: string, server: MCPServerStdio): Promise<void> {
    if (this.disposed || this.refreshingServers.has(name) || this.servers.get(name) !== server) return;
    this.refreshingServers.add(name);
    try {
      await server.invalidateToolsCache();
      const serverTools = await server.listTools();
      if (this.disposed || this.servers.get(name) !== server) return;
      const previousDefinitions = this.tools
        .filter((entry) => entry.serverName === name)
        .map((entry) => entry.definition);
      if (JSON.stringify(previousDefinitions) === JSON.stringify(serverTools)) return;
      this.replaceServerTools(name, server, serverTools);
      const existing = this.serverStatuses.find((status) => status.name === name);
      if (existing) {
        this.setStatus({
          ...existing,
          toolCount: serverTools.length,
          tools: serverTools.map((tool) => `mcp__${name}__${tool.name}`),
        });
      }
      this.onToolsListChanged?.();
    } catch (error) {
      if (!this.disposed && this.servers.get(name) === server && this.isConnectionError(error)) {
        this.markServerFailed(name, error);
      }
    } finally {
      this.refreshingServers.delete(name);
    }
  }

  private attachCloseMonitor(name: string, server: MCPServerStdio): void {
    const internals = server as unknown as SdkServerInternals;
    const transport = internals.underlying?.transport;
    if (!transport) return;
    const previousOnClose = transport.onclose;
    transport.onclose = () => {
      previousOnClose?.();
      if (!this.disposed && !this.intentionallyClosing.has(name) && this.servers.get(name) === server) {
        this.markServerFailed(name, new Error(`MCP server "${name}" connection closed`));
      }
    };
  }

  private async closeServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    this.servers.delete(name);
    this.removeServerEntries(name);
    if (!server) return;
    this.intentionallyClosing.add(name);
    try {
      await server.close();
    } finally {
      this.intentionallyClosing.delete(name);
    }
  }

  private replaceServerTools(name: string, server: MCPServerStdio, tools: SdkMcpTool[]): void {
    this.tools = this.tools.filter((entry) => entry.serverName !== name);
    this.tools.push(
      ...tools.map((definition) => ({
        serverName: name,
        originalName: definition.name,
        namespacedName: `mcp__${name}__${definition.name}`,
        definition,
        server,
      }))
    );
  }

  private replaceServerResources(name: string, server: MCPServerWithResources, resources: MCPResource[]): void {
    this.resources = this.resources.filter((entry) => entry.serverName !== name);
    this.resources.push(
      ...resources.map((definition) => ({
        serverName: name,
        namespacedName: `mcp__${name}__${definition.name ?? definition.uri}`,
        definition,
        server,
      }))
    );
  }

  private replaceServerPrompts(name: string, server: MCPServerStdio, prompts: McpPromptDefinition[]): void {
    this.prompts = this.prompts.filter((entry) => entry.serverName !== name);
    this.prompts.push(
      ...prompts.map((definition) => ({
        serverName: name,
        namespacedName: `mcp__${name}__${definition.name}`,
        definition,
        server,
      }))
    );
  }

  private removeServerEntries(name: string): void {
    this.tools = this.tools.filter((entry) => entry.serverName !== name);
    this.prompts = this.prompts.filter((entry) => entry.serverName !== name);
    this.resources = this.resources.filter((entry) => entry.serverName !== name);
    this.onToolsListChanged?.();
  }

  private getPromptClient(server: MCPServerStdio): McpPromptClient | null {
    // The Agents SDK wrapper does not yet expose MCP prompts, but its official MCP client does.
    return (server as unknown as SdkServerInternals).underlying?.session ?? null;
  }

  private markServerFailed(name: string, error: unknown): void {
    const server = this.servers.get(name);
    this.servers.delete(name);
    if (server) {
      this.intentionallyClosing.add(name);
      void server.close().finally(() => this.intentionallyClosing.delete(name));
    }
    this.removeServerEntries(name);
    this.setStatus({ ...this.emptyStatus(name, "failed"), error: this.errorMessage(error) });
  }

  private normalizeInputSchema(schema: unknown): {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  } {
    const record =
      schema && typeof schema === "object" && !Array.isArray(schema) ? (schema as Record<string, unknown>) : {};
    const properties =
      record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(record.required)
      ? record.required.filter((value): value is string => typeof value === "string")
      : undefined;
    return {
      type: "object",
      properties,
      ...(required ? { required } : {}),
      ...(typeof record.additionalProperties === "boolean"
        ? { additionalProperties: record.additionalProperties }
        : {}),
    };
  }

  private withNpxYesArg(command: string, args: string[]): string[] {
    const executable = path
      .basename(command)
      .toLowerCase()
      .replace(/\.cmd$/, "");
    if (executable !== "npx" || args.includes("-y") || args.includes("--yes")) return args;
    return ["-y", ...args];
  }

  private mergeEnvironment(overrides?: Record<string, string>): Record<string, string> {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    return { ...environment, ...overrides };
  }

  private isConnectionError(error: unknown): boolean {
    const message = this.errorMessage(error).toLowerCase();
    return message.includes("not connected") || message.includes("closed") || message.includes("connection");
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private emptyStatus(name: string, status: McpServerStatus["status"]): McpServerStatus {
    return {
      name,
      status,
      connected: false,
      toolCount: 0,
      tools: [],
      promptCount: 0,
      prompts: [],
      resourceCount: 0,
      resources: [],
    };
  }

  private setStatus(status: McpServerStatus): void {
    if (this.disposed) return;
    const index = this.serverStatuses.findIndex((entry) => entry.name === status.name);
    if (index === -1) this.serverStatuses.push(status);
    else this.serverStatuses[index] = status;
    this.onStatusChanged?.();
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms while ${operation}`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
