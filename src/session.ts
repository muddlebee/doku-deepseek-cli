import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";
import { DEEPSEEK_V4_MODELS } from "./common/model-capabilities";
import { getTools, type ToolDefinition } from "./prompt";
import { ToolExecutor, type CreateOpenAIClient } from "./tools/executor";
import { McpManager } from "./mcp/mcp-manager";
import type { McpServerConfig } from "./settings";
import type { ApiMode, ProviderProfile } from "./settings";
import type { AgentToolInvocation, AgentToolOutput } from "./agent/runtime";
import { ProviderRegistry } from "./providers/registry";
import { FileSessionStore } from "./session/file-session-store";
import { SkillCatalog } from "./session/skill-catalog";
import { identifyMatchingSkills } from "./session/skill-matcher";
import { appendPromptSkills } from "./session/prompt-skills";
import { SessionMessageFactory } from "./session/message-factory";
import { notifyTaskCompletion, reportNewPrompt } from "./session/notifications";
import { SessionProcessTracker } from "./session/process-tracker";
import { SessionToolCoordinator } from "./session/tool-coordinator";
import { initializeSession } from "./session/session-initializer";
import { compactAgentSession } from "./session/compactor";
import { isUndoTargetMessage, SessionCheckpointManager } from "./session/checkpoint-manager";
import { getAgentHistoryPath, hasPausedAgentTurn, removeAgentTurnState, runAgentTurn } from "./session/agent-turn";
import type {
  BashTimeoutAdjustment,
  LlmStreamProgress,
  MessageMeta,
  SessionEntry,
  SessionMessage,
  SkillInfo,
  UndoTarget,
  UserPromptContent,
} from "./session/types";
export type {
  BashTimeoutAdjustment,
  LlmStreamProgress,
  MessageMeta,
  ModelUsage,
  SessionEntry,
  SessionMessage,
  SessionProcessEntry,
  SessionsIndex,
  SessionStatus,
  SkillInfo,
  UndoTarget,
  UserPromptContent,
} from "./session/types";

const DEFAULT_COMPACT_PROMPT_TOKEN_THRESHOLD = 128 * 1024;
// Both deepseek-v4-flash and deepseek-v4-pro have a 1M token context window.
// Compact at 800k to leave headroom for the model's 384k max output.
const DEEPSEEK_V4_COMPACT_PROMPT_TOKEN_THRESHOLD = 800 * 1024;

export function getCompactPromptTokenThreshold(model: string): number {
  return DEEPSEEK_V4_MODELS.has(model)
    ? DEEPSEEK_V4_COMPACT_PROMPT_TOKEN_THRESHOLD
    : DEFAULT_COMPACT_PROMPT_TOKEN_THRESHOLD;
}

function getExtensionRoot(): string {
  if (typeof __dirname !== "undefined") {
    return path.resolve(__dirname, "..");
  }

  const currentFilePath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFilePath), "..");
}

type SessionManagerOptions = {
  projectRoot: string;
  createOpenAIClient: CreateOpenAIClient;
  getResolvedSettings: () => {
    model: string;
    provider?: string;
    providerProfile?: ProviderProfile;
    apiMode?: ApiMode;
    maxTurns?: number;
    tracingEnabled?: boolean;
    webSearchTool?: string;
    webSearchProvider?: string;
    env?: Record<string, string>;
    mcpServers?: Record<string, McpServerConfig>;
  };
  renderMarkdown: (text: string) => string;
  onAssistantMessage: (message: SessionMessage, shouldConnect: boolean) => void;
  onSessionEntryUpdated?: (entry: SessionEntry) => void;
  onLlmStreamProgress?: (progress: LlmStreamProgress) => void;
  onMcpStatusChanged?: () => void;
  onProcessStdout?: (pid: number, chunk: string) => void;
  onNeedsWebSearchSetup?: () => void;
};

export class SessionManager {
  private readonly projectRoot: string;
  private readonly createOpenAIClient: CreateOpenAIClient;
  private readonly getResolvedSettings: () => {
    model: string;
    provider?: string;
    providerProfile?: ProviderProfile;
    apiMode?: ApiMode;
    maxTurns?: number;
    tracingEnabled?: boolean;
    webSearchTool?: string;
    webSearchProvider?: string;
    env?: Record<string, string>;
    mcpServers?: Record<string, McpServerConfig>;
  };
  private readonly onAssistantMessage: (message: SessionMessage, shouldConnect: boolean) => void;
  private readonly onLlmStreamProgress?: (progress: LlmStreamProgress) => void;
  private readonly onMcpStatusChanged?: () => void;
  private activeSessionId: string | null = null;
  private activePromptController: AbortController | null = null;
  private readonly sessionControllers = new Map<string, AbortController>();
  private readonly toolExecutor: ToolExecutor;
  private readonly mcpManager = new McpManager();
  private mcpToolDefinitions: ToolDefinition[] = [];
  private readonly providerRegistry = new ProviderRegistry();
  private readonly sessionStore: FileSessionStore;
  private readonly skillCatalog: SkillCatalog;
  private readonly messageFactory: SessionMessageFactory;
  private readonly processTracker: SessionProcessTracker;
  private readonly checkpoints: SessionCheckpointManager;
  private readonly toolCoordinator: SessionToolCoordinator;

  constructor(options: SessionManagerOptions) {
    this.projectRoot = options.projectRoot;
    this.createOpenAIClient = options.createOpenAIClient;
    this.getResolvedSettings = options.getResolvedSettings;
    this.onAssistantMessage = options.onAssistantMessage;
    this.sessionStore = new FileSessionStore(this.projectRoot, options.onSessionEntryUpdated);
    this.skillCatalog = new SkillCatalog(this.projectRoot, getExtensionRoot(), (sessionId) =>
      this.listSessionMessages(sessionId)
    );
    this.checkpoints = new SessionCheckpointManager(
      this.projectRoot,
      this.sessionStore.projectDir,
      (sessionId) => this.listSessionMessages(sessionId),
      (sessionId, messages) => this.saveSessionMessages(sessionId, messages)
    );
    this.messageFactory = new SessionMessageFactory(this.projectRoot, getExtensionRoot(), (sessionId) =>
      this.checkpoints.currentHash(sessionId)
    );
    this.processTracker = new SessionProcessTracker(
      (sessionId) => this.getSession(sessionId),
      (sessionId, updater) => this.updateSessionEntry(sessionId, updater)
    );
    this.onLlmStreamProgress = options.onLlmStreamProgress;
    this.onMcpStatusChanged = options.onMcpStatusChanged;
    this.toolExecutor = new ToolExecutor(this.projectRoot, this.createOpenAIClient, this.mcpManager);
    this.toolCoordinator = new SessionToolCoordinator({
      executor: this.toolExecutor,
      processes: this.processTracker,
      checkpoints: this.checkpoints,
      appendMessage: (sessionId, message) => this.appendSessionMessage(sessionId, message),
      listMessages: (sessionId) => this.listSessionMessages(sessionId),
      buildAssistant: (sessionId, content, toolCalls) => this.buildAssistantMessage(sessionId, content, toolCalls),
      buildTool: (sessionId, callId, content, toolFunction) =>
        this.buildToolMessage(sessionId, callId, content, toolFunction),
      buildSystem: (sessionId, content, contentParams) => this.buildSystemMessage(sessionId, content, contentParams),
      emitMessage: this.onAssistantMessage,
      isInterrupted: (sessionId) => this.isInterrupted(sessionId),
      onStdout: options.onProcessStdout,
      onNeedsWebSearchSetup: options.onNeedsWebSearchSetup,
    });
    this.mcpManager.prepare(this.getResolvedSettings().mcpServers);
  }

  async initMcpServers(servers?: Record<string, McpServerConfig>): Promise<void> {
    this.mcpManager.setOnToolsListChanged(() => {
      this.mcpToolDefinitions = this.mcpManager.getMcpToolDefinitions();
    });
    // 设置状态变更回调，通知 UI 更新
    this.mcpManager.setOnStatusChanged(() => {
      this.onMcpStatusChanged?.();
    });
    await this.mcpManager.initialize(servers);
    this.mcpToolDefinitions = this.mcpManager.getMcpToolDefinitions();
  }

  getMcpStatus() {
    return this.mcpManager.getStatus();
  }

  async reconnectMcpServer(name: string, config?: McpServerConfig): Promise<void> {
    await this.mcpManager.reconnect(name, config);
    this.mcpToolDefinitions = this.mcpManager.getMcpToolDefinitions();
  }

  dispose(): void {
    this.mcpManager.disconnect();
  }

  private isAbortLikeError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return error.name === "AbortError" || error.constructor.name === "APIUserAbortError";
  }

  private throwIfAborted(signal?: AbortSignal | null): void {
    if (!signal?.aborted) {
      return;
    }

    const error = new Error("Request was aborted.");
    error.name = "AbortError";
    throw error;
  }

  async identifyMatchingSkillNames(
    skills: SkillInfo[],
    userPrompt: string,
    options?: { signal?: AbortSignal; sessionId?: string }
  ): Promise<string[]> {
    return identifyMatchingSkills(skills, userPrompt, {
      createClient: this.createOpenAIClient,
      getSettings: this.getResolvedSettings,
      registry: this.providerRegistry,
      activeWebSearchProvider: this.resolveActiveWebSearchProvider(),
      signal: options?.signal,
      sessionId: options?.sessionId,
    });
  }

  async listSkills(sessionId?: string): Promise<SkillInfo[]> {
    return this.skillCatalog.list(sessionId);
  }

  private appendSkills(
    sessionId: string,
    prompt: UserPromptContent,
    signal: AbortSignal | undefined,
    existingSession: boolean
  ): Promise<void> {
    return appendPromptSkills(sessionId, prompt, signal, existingSession, {
      catalog: this.skillCatalog,
      identify: (skills, text, abortSignal, activeSessionId) =>
        this.identifyMatchingSkillNames(skills, text, { signal: abortSignal, sessionId: activeSessionId }),
      buildMessage: (id, content, skill) => this.buildSkillMessage(id, content, skill),
      appendMessage: (id, message) => this.appendSessionMessage(id, message),
      emitMessage: this.onAssistantMessage,
    });
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  setActiveSessionId(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  addSessionSystemMessage(sessionId: string, content: string, visible?: boolean, meta?: MessageMeta): void {
    const message = this.buildSystemMessage(sessionId, content, null, visible, meta);
    if (sessionId) this.appendSessionMessage(sessionId, message);
    this.onAssistantMessage(message, false);
  }

  async handleUserPrompt(userPrompt: UserPromptContent): Promise<void> {
    const controller = new AbortController();
    this.activePromptController = controller;

    try {
      if (!this.activeSessionId || !this.getSession(this.activeSessionId)) {
        await this.createSession(userPrompt, controller);
      } else {
        await this.replySession(this.activeSessionId, userPrompt, controller);
      }
    } catch (error) {
      if (!this.isAbortLikeError(error) && !controller.signal.aborted) {
        throw error;
      }
    } finally {
      if (this.activePromptController === controller) {
        this.activePromptController = null;
      }
    }
  }

  async createSession(userPrompt: UserPromptContent, controller?: AbortController): Promise<string> {
    this.reportNewPrompt();
    const signal = controller?.signal;
    this.throwIfAborted(signal);

    const sessionId = crypto.randomUUID();
    this.checkpoints.ensureSession(sessionId);
    const promptOptions = this.getPromptToolOptions();
    initializeSession({
      sessionId,
      userPrompt,
      projectRoot: this.projectRoot,
      model: promptOptions.model,
      webSearchProvider: this.resolveActiveWebSearchProvider(),
      store: this.sessionStore,
      messages: this.messageFactory,
      removeSessions: (sessionIds) => this.removeSessionMessages(sessionIds),
    });

    await this.appendSkills(sessionId, userPrompt, signal, false);

    this.activeSessionId = sessionId;
    await this.activateSession(sessionId, controller);
    return sessionId;
  }

  async replySession(sessionId: string, userPrompt: UserPromptContent, controller?: AbortController): Promise<void> {
    const signal = controller?.signal;
    this.throwIfAborted(signal);
    const now = new Date().toISOString();
    const updated = this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "pending",
      failReason: null,
      updateTime: now,
    }));

    if (!updated) {
      await this.createSession(userPrompt, controller);
      return;
    }

    if (this.isContinuePrompt(userPrompt)) {
      this.activeSessionId = sessionId;
      await this.activateSession(sessionId, controller, true);
      return;
    }

    this.reportNewPrompt();

    this.checkpoints.ensureSession(sessionId);
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    await this.appendSkills(sessionId, userPrompt, signal, true);

    this.activeSessionId = sessionId;
    await this.activateSession(sessionId, controller);
  }

  private isContinuePrompt(userPrompt: UserPromptContent): boolean {
    return (
      typeof userPrompt.text === "string" &&
      userPrompt.text.trim() === "/continue" &&
      (!userPrompt.imageUrls || userPrompt.imageUrls.length === 0) &&
      (!userPrompt.skills || userPrompt.skills.length === 0)
    );
  }

  async activateSession(sessionId: string, controller?: AbortController, continueExisting = false): Promise<void> {
    const startedAt = Date.now();
    const clientConfig = this.createOpenAIClient();
    const {
      client,
      model,
      baseURL,
      thinkingEnabled,
      reasoningEffort,
      notify,
      env,
      provider: configuredProvider,
      providerProfile: configuredProfile,
      apiMode: configuredApiMode,
      maxTurns: configuredMaxTurns,
      tracingEnabled: configuredTracing,
      debugLogEnabled,
    } = clientConfig;
    const resolvedSettings = this.getResolvedSettings();
    const providerId = configuredProvider ?? resolvedSettings.provider ?? "custom";
    const providerProfile =
      configuredProfile ??
      resolvedSettings.providerProfile ??
      ({ type: "openai-compatible", baseURL, apiMode: "chat_completions" } satisfies ProviderProfile);
    const apiMode = configuredApiMode ?? resolvedSettings.apiMode ?? providerProfile.apiMode ?? "chat_completions";
    const now = new Date().toISOString();

    if (!client) {
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: "API key not found",
        updateTime: now,
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          "API key not found. Please configure ~/.doku/settings.json or ./.doku/settings.json.",
          null
        ),
        false
      );
      this.maybeNotifyTaskCompletion(sessionId, notify, startedAt, env);
      return;
    }

    const sessionController = controller ?? new AbortController();
    if (sessionController.signal.aborted) {
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "interrupted",
        failReason: "interrupted",
        updateTime: now,
      }));
      this.maybeNotifyTaskCompletion(sessionId, notify, startedAt, env);
      return;
    }

    this.updateSessionEntry(sessionId, (entry) => ({ ...entry, status: "processing", updateTime: now }));
    this.sessionControllers.set(sessionId, sessionController);

    let provider: Awaited<ReturnType<ProviderRegistry["resolve"]>> | null = null;
    try {
      provider = await this.providerRegistry.resolve({
        id: providerId,
        profile: providerProfile,
        model,
        apiKey: client.apiKey ?? undefined,
        baseURL,
        apiMode,
        thinkingEnabled,
        reasoningEffort,
        debugLogEnabled,
        openAIClient: providerProfile.type === "deepseek" ? undefined : client,
      });
      const activeProvider = provider;
      const tracingEnabled = configuredTracing ?? resolvedSettings.tracingEnabled ?? false;
      const compactAtTokens = activeProvider.compactAtTokens ?? getCompactPromptTokenThreshold(model);
      if (
        (this.getSession(sessionId)?.activeTokens ?? 0) >= compactAtTokens &&
        !hasPausedAgentTurn(sessionId, this.sessionStore.projectDir)
      ) {
        await this.compactSessionWithProvider(
          sessionId,
          activeProvider,
          model,
          tracingEnabled,
          sessionController.signal
        );
      }
      await runAgentTurn(
        {
          sessionId,
          provider: activeProvider,
          model,
          tools: getTools(this.getPromptToolOptions(), this.mcpToolDefinitions),
          maxTurns: configuredMaxTurns ?? resolvedSettings.maxTurns ?? 100,
          tracingEnabled,
          controller: sessionController,
          continueExisting,
        },
        {
          store: this.sessionStore,
          listMessages: (id) => this.listSessionMessages(id),
          updateEntry: (id, updater) => this.updateSessionEntry(id, updater),
          appendMessage: (id, message) => this.appendSessionMessage(id, message),
          saveMessages: (id, messages) => this.saveSessionMessages(id, messages),
          buildAssistant: (id, content, toolCalls, reasoning, refusal) =>
            this.buildAssistantMessage(id, content, toolCalls, reasoning, refusal),
          onAssistantMessage: this.onAssistantMessage,
          appendTools: (id, calls, signal, pendingApproval) =>
            this.appendToolMessages(id, calls, signal, pendingApproval),
          executeTool: (id, invocation, supportsImages) => this.executeAgentTool(id, invocation, supportsImages),
          renderContent: (message) => this.renderAgentMessageContent(message),
          onProgress: this.onLlmStreamProgress,
          isInterrupted: (id) => this.isInterrupted(id),
          getTools: () => getTools(this.getPromptToolOptions(), this.mcpToolDefinitions),
          compactIfNeeded: async (activeTokens, signal) => {
            if (activeTokens < compactAtTokens || hasPausedAgentTurn(sessionId, this.sessionStore.projectDir)) {
              return;
            }
            await this.compactSessionWithProvider(sessionId, activeProvider, model, tracingEnabled, signal);
          },
        }
      );
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      const aborted = this.isAbortLikeError(error) || sessionController.signal.aborted;
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: aborted ? "interrupted" : "failed",
        failReason: aborted ? "interrupted" : errMessage,
        updateTime: new Date().toISOString(),
      }));
      if (!aborted) {
        this.onAssistantMessage(this.buildAssistantMessage(sessionId, `Request failed: ${errMessage}`, null), false);
      }
    } finally {
      await provider?.close().catch(() => {});
      if (this.sessionControllers.get(sessionId) === sessionController) this.sessionControllers.delete(sessionId);
      this.maybeNotifyTaskCompletion(sessionId, notify, startedAt, env);
    }
  }

  private executeAgentTool(
    sessionId: string,
    invocation: AgentToolInvocation,
    supportsImages: boolean
  ): Promise<AgentToolOutput> {
    return this.toolCoordinator.executeAgentTool(sessionId, invocation, supportsImages);
  }

  private getPausedRunStatePath(sessionId: string): string {
    return path.join(this.sessionStore.projectDir, `${sessionId}.run-state.json`);
  }

  private getAgentSessionPath(sessionId: string): string {
    return getAgentHistoryPath(sessionId, this.sessionStore.projectDir);
  }

  private removeAgentRuntimeState(sessionId: string): void {
    removeAgentTurnState(sessionId, this.sessionStore.projectDir);
  }

  async compactSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    const config = this.createOpenAIClient();
    if (!config.client) return;
    const resolvedSettings = this.getResolvedSettings();
    const profile =
      config.providerProfile ??
      resolvedSettings.providerProfile ??
      ({ type: "openai-compatible", baseURL: config.baseURL, apiMode: "chat_completions" } satisfies ProviderProfile);
    const provider = await this.providerRegistry.resolve({
      id: config.provider ?? resolvedSettings.provider ?? "custom",
      profile,
      model: config.model,
      apiKey: config.client.apiKey ?? undefined,
      baseURL: config.baseURL,
      apiMode: config.apiMode ?? resolvedSettings.apiMode ?? profile.apiMode ?? "chat_completions",
      thinkingEnabled: config.thinkingEnabled,
      reasoningEffort: config.reasoningEffort,
      debugLogEnabled: config.debugLogEnabled,
      openAIClient: profile.type === "deepseek" ? undefined : config.client,
    });
    try {
      await this.compactSessionWithProvider(
        sessionId,
        provider,
        config.model,
        config.tracingEnabled ?? resolvedSettings.tracingEnabled ?? false,
        signal
      );
    } finally {
      await provider.close().catch(() => {});
    }
  }

  private async compactSessionWithProvider(
    sessionId: string,
    provider: Awaited<ReturnType<ProviderRegistry["resolve"]>>,
    model: string,
    tracingEnabled: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    await compactAgentSession(sessionId, provider, model, tracingEnabled, signal, {
      listMessages: (id) => this.listSessionMessages(id),
      saveMessages: (id, messages) => this.saveSessionMessages(id, messages),
      updateEntry: (id, updater) => this.updateSessionEntry(id, updater),
      renderContent: (message) => this.renderAgentMessageContent(message),
      agentHistoryPath: (id) => this.getAgentSessionPath(id),
    });
  }

  private resolveActiveWebSearchProvider(): string | undefined {
    const settings = this.getResolvedSettings();
    const { webSearchProvider, webSearchTool } = settings;
    if (webSearchTool) return "custom-script";
    if (webSearchProvider === "tavily" && settings.env?.TAVILY_API_KEY?.trim()) return "tavily";
    if (webSearchProvider === "firecrawl" && settings.env?.FIRECRAWL_API_KEY?.trim()) return "firecrawl";
    return undefined;
  }

  private getPromptToolOptions(): { model: string; webSearchEnabled: boolean } {
    return {
      model: this.getResolvedSettings().model,
      webSearchEnabled: true,
    };
  }

  private reportNewPrompt(): void {
    reportNewPrompt(this.createOpenAIClient().machineId);
  }

  interruptActiveSession(): void {
    const controller = this.activePromptController;
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }

    const sessionId = this.activeSessionId;
    if (sessionId) {
      this.interruptSession(sessionId);
    }
  }

  interruptSession(sessionId: string): void {
    const { killedPids, failedPids } = this.processTracker.killAll(sessionId);

    const controller = this.sessionControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.sessionControllers.delete(sessionId);
    }

    const now = new Date().toISOString();
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "interrupted",
      failReason: "interrupted",
      processes: null,
      updateTime: now,
    }));

    const contentParts = ["Interrupted."];
    if (killedPids.length > 0) {
      contentParts.push(`Killed processes: ${killedPids.join(", ")}.`);
    }
    if (failedPids.length > 0) {
      contentParts.push(`Failed to kill processes: ${failedPids.join(", ")}.`);
    }

    this.onAssistantMessage(this.buildUserMessage(sessionId, { text: contentParts.join(" ") }), false);
  }

  private isInterrupted(sessionId: string): boolean {
    return !this.sessionControllers.has(sessionId);
  }

  adjustActiveBashTimeout(deltaMs: number): BashTimeoutAdjustment | null {
    return this.processTracker.adjust(this.activeSessionId, deltaMs);
  }

  listSessions(): SessionEntry[] {
    return this.sessionStore.listSessions();
  }

  getSession(sessionId: string): SessionEntry | null {
    return this.sessionStore.getSession(sessionId);
  }

  listSessionMessages(sessionId: string): SessionMessage[] {
    return this.sessionStore.listMessages(sessionId);
  }

  listUndoTargets(sessionId: string): UndoTarget[] {
    return this.listSessionMessages(sessionId)
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => isUndoTargetMessage(message))
      .map(({ message, index }) => ({
        message,
        index,
        canRestoreCode: Boolean(
          message.checkpointHash && this.checkpoints.canRestore(sessionId, message.checkpointHash)
        ),
      }));
  }

  restoreSessionConversation(sessionId: string, messageId: string): SessionMessage[] {
    const messages = this.listSessionMessages(sessionId);
    const targetIndex = messages.findIndex((message) => message.id === messageId);
    if (targetIndex === -1) {
      throw new Error("Selected message was not found in this session.");
    }

    const keptMessages = messages.slice(0, targetIndex);
    this.saveSessionMessages(sessionId, keptMessages);
    this.removeAgentRuntimeState(sessionId);
    const now = new Date().toISOString();
    const latestAssistant = [...keptMessages].reverse().find((message) => message.role === "assistant");
    const latestAssistantParams = latestAssistant?.messageParams as
      | { tool_calls?: unknown[]; reasoning_content?: string }
      | null
      | undefined;

    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      assistantReply: latestAssistant?.content ?? null,
      assistantThinking:
        typeof latestAssistantParams?.reasoning_content === "string" ? latestAssistantParams.reasoning_content : null,
      assistantRefusal: null,
      toolCalls: null,
      status: "completed",
      failReason: null,
      processes: null,
      updateTime: now,
    }));
    return keptMessages;
  }

  restoreSessionCode(sessionId: string, messageId: string): void {
    const message = this.listSessionMessages(sessionId).find((item) => item.id === messageId);
    if (!message) {
      throw new Error("Selected message was not found in this session.");
    }
    if (!message.checkpointHash) {
      throw new Error("Selected message has no code checkpoint.");
    }
    this.checkpoints.restore(sessionId, message.checkpointHash);
  }

  private removeSessionMessages(sessionIds: string[]): void {
    this.sessionStore.removeMessages(sessionIds);
    sessionIds.forEach((sessionId) => this.removeAgentRuntimeState(sessionId));
  }

  private appendSessionMessage(sessionId: string, message: SessionMessage): void {
    this.sessionStore.appendMessage(sessionId, message);
  }

  private saveSessionMessages(sessionId: string, messages: SessionMessage[]): void {
    this.sessionStore.saveMessages(sessionId, messages);
  }

  private updateSessionEntry(sessionId: string, updater: (entry: SessionEntry) => SessionEntry): SessionEntry | null {
    return this.sessionStore.updateEntry(sessionId, updater);
  }

  private buildUserMessage(sessionId: string, prompt: UserPromptContent): SessionMessage {
    return this.messageFactory.user(sessionId, prompt);
  }

  private renderInitCommandPrompt(): string {
    return this.messageFactory.renderInitPrompt();
  }

  private loadAgentInstructions(): string | null {
    return this.messageFactory.loadAgentInstructions();
  }

  private buildSystemMessage(
    sessionId: string,
    content: string,
    contentParams: unknown | null = null,
    visible = false,
    meta?: MessageMeta
  ): SessionMessage {
    return this.messageFactory.system(sessionId, content, contentParams, visible, meta);
  }

  private buildSkillMessage(sessionId: string, content: string, skill: SkillInfo): SessionMessage {
    return this.messageFactory.skill(sessionId, content, skill);
  }

  private buildAssistantMessage(
    sessionId: string,
    content: string | null,
    toolCalls: unknown[] | null,
    reasoningContent?: string | null,
    refusal?: string | null
  ): SessionMessage {
    return this.messageFactory.assistant(sessionId, content, toolCalls, reasoningContent, refusal);
  }

  private buildToolMessage(
    sessionId: string,
    toolCallId: string,
    content: string,
    toolFunction: unknown | null
  ): SessionMessage {
    return this.messageFactory.tool(sessionId, toolCallId, content, toolFunction);
  }

  private appendToolMessages(
    sessionId: string,
    toolCalls: unknown[],
    signal?: AbortSignal,
    pendingApproval = false
  ): Promise<{ waitingForUser: boolean }> {
    return this.toolCoordinator.append(sessionId, toolCalls, signal, pendingApproval);
  }

  private renderAgentMessageContent(message: SessionMessage): string {
    if (message.role === "user" && message.content === "/init") return this.renderInitCommandPrompt();
    return message.content ?? "";
  }

  private maybeNotifyTaskCompletion(
    sessionId: string,
    notifyCommand: string | undefined,
    startedAt: number,
    configuredEnv: Record<string, string> = {}
  ): void {
    notifyTaskCompletion({
      command: notifyCommand,
      startedAt,
      projectRoot: this.projectRoot,
      env: configuredEnv,
      session: this.getSession(sessionId),
      messages: this.listSessionMessages(sessionId),
    });
  }
}
