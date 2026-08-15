import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useStdout, useWindowSize } from "ink";
import { StatusMessage } from "@inkjs/ui";
import chalk from "chalk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createOpenAIClient } from "../common/openai-client";
import { getWebSearchApiKeyEnv } from "../common/web-search-provider";
import {
  type LlmStreamProgress,
  type MessageMeta,
  type SessionEntry,
  SessionBusyError,
  SessionManager,
  type SessionMessage,
  type SkillInfo,
  type UndoTarget,
  type UserPromptContent,
} from "../session";
import {
  applyModelConfigSelection,
  type DeepcodingSettings,
  type ModelConfigSelection,
  type ResolvedDeepcodingSettings,
  resolveSettingsSources,
} from "../settings";
import { loadProjectEnv } from "../common/project-env";
import { getNextWorkflowMode, PromptInput, type PromptDraft } from "./PromptInput";
import type { PromptSubmission } from "./promptSubmission";
import { MessageView, RawModeExitPrompt } from "./components";
import { SessionList } from "./SessionList";
import { UndoSelector, type UndoRestoreMode } from "./UndoSelector";
import { buildLoadingText } from "./loadingText";
import { findExpandedThinkingId } from "./thinkingState";
import { WelcomeScreen } from "./WelcomeScreen";
import { AskUserQuestionPrompt } from "./AskUserQuestionPrompt";
import { McpStatusList } from "./McpStatusList";
import { ProcessStdoutView } from "./ProcessStdoutView";
import {
  type AskUserQuestionAnswers,
  findPendingAskUserQuestion,
  formatAskUserQuestionAnswers,
  formatAskUserQuestionDecline,
} from "./askUserQuestion";
import { buildExitSummaryText } from "./exitSummary";
import { RawMode, useRawModeContext } from "./contexts";
import { renderMessageToStdout } from "./components/MessageView/utils";
import { WebSearchSetupScreen } from "./WebSearchSetupScreen";
import { PlanHandoffPrompt } from "./PlanHandoffPrompt";
import { PLAN_STATUS, WORKFLOW_MODE, type WorkflowMode } from "../session/types";
import { buildChatStatus, reconcileChatError } from "./chat-status";
import { transitionView, type AppView } from "./view-state";
import {
  SerialPromptQueue,
  PROMPT_ROUTE,
  resolvePromptRoute,
  shouldDiscardPromptQueueAfterSessionSelection,
  shouldDiscardPromptQueueAfterUndoRestore,
  shouldDiscardPromptQueueForCommand,
  shouldDiscardPromptQueueForModeChange,
  shouldPausePromptQueue,
  shouldResumePromptQueueAfterRecovery,
  type QueuedPrompt,
} from "./serialPromptQueue";

const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_BASE_URL = "https://api.deepseek.com";

type AppProps = {
  projectRoot: string;
  initialPrompt?: string;
  onRestart?: () => void;
};

export function App({ projectRoot, initialPrompt, onRestart }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout, write } = useStdout();
  const { columns, rows } = useWindowSize();
  const { mode, setMode } = useRawModeContext();
  const initialPromptSubmittedRef = useRef(false);
  const processStdoutRef = useRef<Map<number, string>>(new Map());
  const rawModeRef = useRef<RawMode>(mode);
  const writeRef = useRef(write);
  const lastRenderedColumnsRef = useRef<number | null>(null);
  const messagesRef = useRef<SessionMessage[]>([]);
  const sessionManagerRef = useRef<SessionManager | null>(null);
  const promptProcessorRef = useRef<((submission: PromptSubmission) => Promise<void>) | null>(null);
  const promptQueueRef = useRef<SerialPromptQueue<PromptSubmission> | null>(null);
  const [view, setView] = useState<AppView>("chat");
  const [busy, setBusy] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [undoTargets, setUndoTargets] = useState<UndoTarget[]>([]);
  const [promptDraft, setPromptDraft] = useState<PromptDraft | null>(null);
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [streamProgress, setStreamProgress] = useState<LlmStreamProgress | null>(null);
  const [runningProcesses, setRunningProcesses] = useState<SessionEntry["processes"]>(null);
  const [activeEntry, setActiveEntry] = useState<SessionEntry | null>(null);
  const [dismissedQuestionIds, setDismissedQuestionIds] = useState<Set<string>>(() => new Set());
  const [dismissedPlanRevisions, setDismissedPlanRevisions] = useState<Set<string>>(() => new Set());
  const [isExiting, setIsExiting] = useState(false);
  const [showWelcome, setShowWelcome] = useState(true);
  const [welcomeNonce, setWelcomeNonce] = useState(0);
  const [resolvedSettings, setResolvedSettings] = useState(() => resolveCurrentSettings(projectRoot));
  const [nowTick, setNowTick] = useState(0);
  const [mcpStatuses, setMcpStatuses] = useState<ReturnType<typeof sessionManager.getMcpStatus>>([]);
  const [showProcessStdout, setShowProcessStdout] = useState(false);
  const [pendingWorkflowMode, setPendingWorkflowMode] = useState<WorkflowMode>(WORKFLOW_MODE.BUILD);
  const [queuedPrompts, setQueuedPrompts] = useState<readonly QueuedPrompt<PromptSubmission>[]>([]);

  const openSecondaryView = useCallback((nextView: Exclude<AppView, "chat">): void => {
    setShowWelcome(false);
    setView((current) => transitionView(current, { type: "open", view: nextView }));
  }, []);

  rawModeRef.current = mode;
  messagesRef.current = messages;

  const sessionManager = useMemo(() => {
    return new SessionManager({
      projectRoot,
      createOpenAIClient: () => createOpenAIClient(projectRoot),
      getResolvedSettings: () => resolveCurrentSettings(projectRoot),
      renderMarkdown: (text) => text,
      onAssistantMessage: (message: SessionMessage) => {
        if (message.meta?.notice === "error") {
          if (rawModeRef.current === RawMode.Raw) {
            process.stdout.write(`\n${renderMessageToStdout(message, rawModeRef.current)}\n\n`);
          } else {
            setErrorLine(message.content || "Unknown provider error");
          }
          return;
        }
        setMessages((prev) => [...prev, message]);
        if (rawModeRef.current === RawMode.Raw) {
          process.stdout.write("\n");
          process.stdout.write(renderMessageToStdout(message, rawModeRef.current) + "\n\n");
        }
      },
      onSessionEntryUpdated: (entry) => {
        if (sessionManagerRef.current?.getActiveSessionId() !== entry.id) return;
        setRunningProcesses(entry.processes);
        setActiveEntry(entry);
        setErrorLine((current) => reconcileChatError(current, entry));
      },
      onLlmStreamProgress: (progress) => {
        if (progress.phase === "end") {
          setStreamProgress(null);
          return;
        }
        setStreamProgress(progress);
      },
      onMcpStatusChanged: () => {
        // 当 MCP 状态变更时，如果当前正在查看 MCP 状态页面，则更新显示
        setMcpStatuses(sessionManager.getMcpStatus());
      },
      onProcessStdout: (pid, chunk) => {
        const buf = processStdoutRef.current;
        const current = buf.get(pid) ?? "";
        // Cap at 1 MB per process to avoid unbounded memory growth
        // on noisy or long-running commands like `yes` or verbose builds.
        const MAX_STDOUT_BUFFER = 1_000_000;
        if (current.length >= MAX_STDOUT_BUFFER) {
          return;
        }
        const text = typeof chunk === "string" ? chunk : String(chunk);
        const available = MAX_STDOUT_BUFFER - current.length;
        buf.set(pid, current + text.slice(0, available));
      },
      onNeedsWebSearchSetup: () => {
        openSecondaryView("web-search-setup");
      },
    });
  }, [openSecondaryView, projectRoot]);
  sessionManagerRef.current = sessionManager;

  if (!promptQueueRef.current) {
    promptQueueRef.current = new SerialPromptQueue({
      process: async (submission) => {
        const processor = promptProcessorRef.current;
        if (!processor) throw new Error("The prompt processor is not ready.");
        await processor(submission);
      },
      onPendingChange: setQueuedPrompts,
      onError: (error) => setErrorLine(error instanceof Error ? error.message : String(error)),
      canContinue: () => {
        const manager = sessionManagerRef.current;
        const sessionId = manager?.getActiveSessionId();
        if (!manager || !sessionId) return true;
        const session = manager.getSession(sessionId);
        return !shouldPausePromptQueue(session?.status, session?.workflow.plan?.status);
      },
    });
  }

  const closeSecondaryView = useCallback((): void => {
    setView((current) => transitionView(current, { type: "close" }));
    setShowWelcome(!sessionManager.getActiveSessionId());
  }, [sessionManager]);

  useEffect(() => {
    if (!busy) {
      return;
    }
    const id = setInterval(() => setNowTick((tick) => tick + 1), 500);
    return () => clearInterval(id);
  }, [busy]);

  function loadVisibleMessages(manager: SessionManager, sessionId: string): SessionMessage[] {
    return manager.listSessionMessages(sessionId).filter((m) => m.visible);
  }

  const refreshSessionsList = useCallback((): void => {
    setSessions(sessionManager.listSessions());
  }, [sessionManager]);

  const refreshSkills = useCallback(
    async (sessionId?: string): Promise<void> => {
      try {
        const list = await sessionManager.listSkills(sessionId ?? sessionManager.getActiveSessionId() ?? undefined);
        setSkills(list);
      } catch {
        // ignore
      }
    },
    [sessionManager]
  );

  useEffect(() => {
    refreshSessionsList();
    void refreshSkills();
  }, [refreshSessionsList, refreshSkills]);

  // Eagerly create the OpenAI client on mount so the TCP+TLS connection
  // warmup (fire-and-forget inside createOpenAIClient) starts before the
  // user sends their first prompt.
  useEffect(() => {
    createOpenAIClient(projectRoot);
  }, [projectRoot]);

  useLayoutEffect(() => {
    const settings = resolveCurrentSettings(projectRoot);
    void sessionManager.initMcpServers(settings.mcpServers);
  }, [projectRoot, sessionManager]);

  useEffect(() => {
    return () => {
      sessionManager.dispose();
    };
  }, [sessionManager]);

  writeRef.current = write;
  const handlePrompt = useCallback(
    async (submission: PromptSubmission) => {
      if (submission.command === "exit") {
        sessionManager.interruptActiveSession();
        setIsExiting(true);
        setTimeout(() => {
          const activeSessionId = sessionManager.getActiveSessionId();
          const session = activeSessionId ? sessionManager.getSession(activeSessionId) : null;
          const summary = buildExitSummaryText({ session });
          process.stdout.write("\n");
          process.stdout.write(chalk.rgb(34, 154, 195)("> /exit "));
          process.stdout.write("\n\n");
          process.stdout.write(summary);
          process.stdout.write("\n\n");
          sessionManager.dispose();
          exit();
        }, 0);
        return;
      }
      if (submission.command === "new") {
        if (onRestart) {
          onRestart();
        } else {
          writeRef.current("\u001B[2J\u001B[3J\u001B[H");
          sessionManager.setActiveSessionId(null);
          setMessages([]);
          setErrorLine(null);
          setRunningProcesses(null);
          setActiveEntry(null);
          setPendingWorkflowMode(WORKFLOW_MODE.BUILD);
          setDismissedQuestionIds(new Set());
          setShowWelcome(true);
          setWelcomeNonce((n) => n + 1);
          await refreshSkills();
          refreshSessionsList();
        }
        return;
      }
      if (submission.command === "resume") {
        refreshSessionsList();
        openSecondaryView("session-list");
        return;
      }
      if (submission.command === "undo") {
        const activeSessionId = sessionManager.getActiveSessionId();
        if (!activeSessionId) {
          setErrorLine("No active session to undo.");
          return;
        }
        setUndoTargets(sessionManager.listUndoTargets(activeSessionId));
        openSecondaryView("undo");
        return;
      }
      if (submission.command === "mcp") {
        setMcpStatuses(sessionManager.getMcpStatus());
        openSecondaryView("mcp-status");
        return;
      }
      if (submission.command === "setup-websearch") {
        openSecondaryView("web-search-setup");
        return;
      }

      const prompt: UserPromptContent = {
        text: submission.text,
        imageUrls: submission.imageUrls,
        workflowMode: submission.workflowMode,
        skills:
          submission.selectedSkills && submission.selectedSkills.length > 0 ? submission.selectedSkills : undefined,
      };

      const trimmedText = (submission.text ?? "").trim();
      const selectedSkillNames = submission.selectedSkills?.map((skill) => skill.name).filter(Boolean) ?? [];
      const userDisplayContent =
        trimmedText ||
        (selectedSkillNames.length > 0 ? `Use skills: ${selectedSkillNames.join(", ")}` : "") ||
        (submission.imageUrls.length > 0 ? "[Image]" : "");

      if (userDisplayContent) {
        setMessages((prev) => [...prev, buildSyntheticUserMessage(userDisplayContent, submission.imageUrls.length)]);
      }

      setBusy(true);
      setErrorLine(null);
      setRunningProcesses(null);
      setShowProcessStdout(false);
      processStdoutRef.current.clear();
      try {
        if (submission.command === "build") {
          const sessionId = sessionManager.getActiveSessionId();
          if (!sessionId) throw new Error("No finalized plan is ready to implement.");
          await sessionManager.approveAndBuild(sessionId);
        } else {
          await sessionManager.handleUserPrompt(prompt);
        }
        await refreshSkills();
        refreshSessionsList();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof SessionBusyError) {
          const sessionId = sessionManager.getActiveSessionId();
          if (sessionId) {
            setMessages(loadVisibleMessages(sessionManager, sessionId));
            setActiveEntry(sessionManager.getSession(sessionId));
          }
        }
        setErrorLine(message);
      } finally {
        setBusy(false);
        setStreamProgress(null);
        setRunningProcesses(null);
      }
    },
    [exit, onRestart, openSecondaryView, sessionManager, refreshSkills, refreshSessionsList]
  );

  const handleInterrupt = useCallback(() => {
    sessionManager.interruptActiveSession();
  }, [sessionManager]);

  const handleToggleProcessStdout = useCallback(() => {
    setShowProcessStdout(true);
  }, []);

  const handleDismissProcessStdout = useCallback(() => {
    setShowProcessStdout(false);
  }, []);

  const handleAdjustBashTimeout = useCallback(
    (deltaMs: number) => sessionManager.adjustActiveBashTimeout(deltaMs),
    [sessionManager]
  );

  const redrawStaticChat = useCallback((nextMessages: SessionMessage[]): void => {
    writeRef.current("\u001B[2J\u001B[3J\u001B[H");
    setMessages([]);
    setShowWelcome(false);
    setWelcomeNonce((nonce) => nonce + 1);
    setTimeout(() => {
      setMessages(nextMessages);
      setShowWelcome(true);
    }, 0);
  }, []);

  const handleModelConfigChange = useCallback(
    (selection: ModelConfigSelection): string => {
      const current = resolveCurrentSettings(projectRoot);
      const { changed } = writeModelConfigSelection(selection, current, projectRoot);
      const next = resolveCurrentSettings(projectRoot);
      setResolvedSettings(next);

      if (!changed) {
        return "Model settings unchanged";
      }

      const activeSessionId = sessionManager.getActiveSessionId();
      const meta: MessageMeta = {
        isModelChange: true,
      };
      const content = `/model\n└ Set ${selection.provider ?? next.provider}/${selection.model} (${selection?.thinkingEnabled ? selection?.reasoningEffort : "no thinking"})`;

      if (activeSessionId) {
        sessionManager.addSessionSystemMessageWithLease(activeSessionId, content, true, meta);
        redrawStaticChat(loadVisibleMessages(sessionManager, activeSessionId));
      } else {
        const now = new Date().toISOString();
        const message: SessionMessage = {
          id: crypto.randomUUID(),
          sessionId: "local",
          role: "system",
          content,
          contentParams: null,
          messageParams: null,
          compacted: false,
          visible: true,
          createTime: now,
          updateTime: now,
          meta,
        };
        redrawStaticChat([...messagesRef.current, message]);
      }

      return `Model settings updated: ${formatModelConfig(current)} → ${formatModelConfig(next)}`;
    },
    [projectRoot, redrawStaticChat, sessionManager]
  );

  const handleSubmit = useCallback(
    (submission: PromptSubmission): boolean => {
      const promptQueue = promptQueueRef.current;
      const sessionId = sessionManager.getActiveSessionId();
      const session = sessionId ? sessionManager.getSession(sessionId) : null;
      if (shouldPausePromptQueue(session?.status, session?.workflow.plan?.status)) {
        promptQueue?.pause();
      }
      const route = resolvePromptRoute(
        submission,
        session?.status,
        session?.workflow.plan?.status,
        promptQueue?.isPaused() ?? false
      );
      if (route === PROMPT_ROUTE.DIRECT_RECOVERY) {
        const accepted =
          promptQueue?.enqueuePriority(submission, () => {
            const recoveredSessionId = sessionManager.getActiveSessionId();
            const recoveredStatus = recoveredSessionId
              ? sessionManager.getSession(recoveredSessionId)?.status
              : undefined;
            return shouldResumePromptQueueAfterRecovery(route, submission.command, recoveredStatus);
          }) ?? false;
        if (!accepted) {
          setErrorLine("The prompt queue is full. Wait for a turn to finish before adding another message.");
        }
        return accepted;
      }
      if (route === PROMPT_ROUTE.DIRECT_COMMAND) {
        if (shouldDiscardPromptQueueForCommand(submission.command)) {
          promptQueue?.clear();
        }
        void handlePrompt(submission).finally(() => {
          const recoveredSessionId = sessionManager.getActiveSessionId();
          const recoveredStatus = recoveredSessionId
            ? sessionManager.getSession(recoveredSessionId)?.status
            : undefined;
          if (shouldResumePromptQueueAfterRecovery(route, submission.command, recoveredStatus)) {
            promptQueue?.resume();
          }
        });
        return true;
      }
      const accepted = promptQueue?.enqueue(submission) ?? false;
      if (!accepted) {
        setErrorLine("The prompt queue is full. Wait for a turn to finish before adding another message.");
      }
      return accepted;
    },
    [handlePrompt, sessionManager]
  );

  promptProcessorRef.current = handlePrompt;

  const handleWorkflowModeChange = useCallback(
    (nextMode: WorkflowMode): void => {
      const sessionId = sessionManager.getActiveSessionId();
      if (!sessionId) {
        setPendingWorkflowMode(nextMode);
        return;
      }
      try {
        const promptQueue = promptQueueRef.current;
        const session = sessionManager.getSession(sessionId);
        const discardAbandonedPrompts = shouldDiscardPromptQueueForModeChange({
          isPaused: promptQueue?.isPaused() ?? false,
          sessionStatus: session?.status,
          currentMode: session?.workflow.mode ?? nextMode,
          planStatus: session?.workflow.plan?.status,
          nextMode,
        });
        sessionManager.setWorkflowMode(sessionId, nextMode);
        if (discardAbandonedPrompts) promptQueue?.clear();
        setErrorLine(null);
      } catch (error) {
        setErrorLine(error instanceof Error ? error.message : String(error));
      }
    },
    [sessionManager]
  );

  const reloadActiveSessionView = useCallback(
    (sessionId: string): void => {
      redrawStaticChat(loadVisibleMessages(sessionManager, sessionId));
    },
    [redrawStaticChat, sessionManager]
  );

  useEffect(() => {
    if (initialPromptSubmittedRef.current || !initialPrompt || !initialPrompt.trim()) {
      return;
    }

    initialPromptSubmittedRef.current = true;
    handleSubmit({
      text: initialPrompt,
      imageUrls: [],
      selectedSkills: undefined,
    });
  }, [handleSubmit, initialPrompt]);

  function handleWebSearchSetupComplete({
    provider,
    apiKey,
  }: {
    provider: "tavily" | "firecrawl";
    apiKey: string;
  }): void {
    const existing = readSettings() ?? {};
    const envKey = getWebSearchApiKeyEnv(provider);
    writeSettings({ ...existing, webSearchProvider: provider, env: { ...existing.env, [envKey]: apiKey } });
    closeSecondaryView();
  }

  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      const currentSessionId = sessionManager.getActiveSessionId();
      if (shouldDiscardPromptQueueAfterSessionSelection(currentSessionId, sessionId)) {
        promptQueueRef.current?.clear();
      }
      if (currentSessionId !== sessionId) {
        process.stdout.write("\u001B[2J\u001B[3J\u001B[H");
      }
      sessionManager.setActiveSessionId(sessionId);
      setErrorLine(null);
      // Clear first so <Static> resets its index to 0.
      setMessages([]);
      setShowWelcome(false);
      setWelcomeNonce((n) => n + 1);
      closeSecondaryView();
      // Load messages after the reset so all static items are rendered.
      setTimeout(() => {
        setMessages(loadVisibleMessages(sessionManager, sessionId));
        setShowWelcome(true);
      }, 0);
      const session = sessionManager.getSession(sessionId);
      setRunningProcesses(session?.processes ?? null);
      setActiveEntry(session);
      await refreshSkills(sessionId);
    },
    [closeSecondaryView, sessionManager, refreshSkills]
  );

  const handleUndoRestore = useCallback(
    async (target: UndoTarget, restoreMode: UndoRestoreMode): Promise<void> => {
      const sessionId = sessionManager.getActiveSessionId();
      if (!sessionId) {
        setErrorLine("No active session to undo.");
        closeSecondaryView();
        return;
      }

      const errors: string[] = [];
      let codeRestored = false;
      let conversationRestored = false;
      if (restoreMode === "code-and-conversation") {
        try {
          sessionManager.restoreSessionCodeAndConversation(sessionId, target.message.id);
          codeRestored = true;
          conversationRestored = true;
        } catch (error) {
          errors.push(
            `Code and conversation restore failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else {
        try {
          sessionManager.restoreSessionConversation(sessionId, target.message.id);
          conversationRestored = true;
        } catch (error) {
          errors.push(`Conversation restore failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (shouldDiscardPromptQueueAfterUndoRestore(codeRestored, conversationRestored)) {
        promptQueueRef.current?.clear();
      }

      refreshSessionsList();
      await refreshSkills(sessionId);
      closeSecondaryView();
      setErrorLine(errors.length > 0 ? errors.join(" ") : null);
      if (conversationRestored) {
        setPromptDraft(buildPromptDraftFromSessionMessage(target.message, Date.now()));
      }
      reloadActiveSessionView(sessionId);
    },
    [closeSecondaryView, reloadActiveSessionView, refreshSessionsList, refreshSkills, sessionManager]
  );

  const handleRawModeChange = useCallback(
    (nextMode: string) => {
      const activeSessionId = sessionManager.getActiveSessionId();
      setMode(nextMode as RawMode);
      // Reset chat view state synchronously so the transition frame does not
      // re-render a stale welcome screen before handleSelectSession runs.
      setShowWelcome(false);
      setMessages([]);
      // Clear screen to remove stale formatted text.
      process.stdout.write("\u001B[2J\u001B[3J\u001B[H");

      setTimeout(() => {
        if (nextMode === RawMode.Raw) {
          // Write all messages directly to stdout for raw scrollback mode.
          const allMessages = activeSessionId ? loadVisibleMessages(sessionManager, activeSessionId) : [];
          for (const msg of allMessages) {
            process.stdout.write("\n");
            process.stdout.write(renderMessageToStdout(msg, nextMode) + "\n\n");
          }
          if (allMessages.length > 0) {
            process.stdout.write("\n\n");
            process.stdout.write(chalk.dim("Press ESC to exit raw mode"));
          } else {
            process.stdout.write("\n");
            process.stdout.write(chalk.dim("(No messages in this session yet. Start chatting to see them here.)"));
            process.stdout.write("\n\n");
            process.stdout.write(chalk.dim("Press ESC to exit raw mode"));
          }
        } else if (activeSessionId) {
          // Switch to chat view to render messages.
          handleSelectSession(activeSessionId);
        } else {
          // No active session: just show the welcome screen once.
          setWelcomeNonce((n) => n + 1);
          setShowWelcome(true);
        }
      }, 200);
    },
    [handleSelectSession, sessionManager, setMode]
  );

  useEffect(() => {
    if (!stdout?.isTTY) {
      return;
    }
    if (columns <= 0) {
      return;
    }
    if (lastRenderedColumnsRef.current === null) {
      lastRenderedColumnsRef.current = columns;
      return;
    }
    if (lastRenderedColumnsRef.current === columns) {
      return;
    }
    lastRenderedColumnsRef.current = columns;

    if (mode === RawMode.Raw) {
      // In raw mode, re-render all messages directly to stdout at the new width.
      // Use process.stdout.write instead of writeRef to avoid Ink interference.
      process.stdout.write("\u001B[2J\u001B[3J\u001B[H");
      const activeSessionId = sessionManager.getActiveSessionId();
      const allMessages = activeSessionId ? loadVisibleMessages(sessionManager, activeSessionId) : [];
      for (const msg of allMessages) {
        process.stdout.write("\n");
        process.stdout.write(renderMessageToStdout(msg, mode) + "\n\n");
      }
      if (allMessages.length > 0) {
        process.stdout.write("\n\n");
        process.stdout.write(chalk.dim("Press ESC to exit raw mode"));
      } else {
        process.stdout.write("\n");
        process.stdout.write(chalk.dim("(No messages in this session yet. Start chatting to see them here.)"));
        process.stdout.write("\n\n");
        process.stdout.write(chalk.dim("Press ESC to exit raw mode"));
      }
      return;
    }

    // Force full redraw on terminal resize to avoid stale wrapped rows.
    writeRef.current("\u001B[2J\u001B[H");

    setMessages([]);
    setShowWelcome(false);
    setWelcomeNonce((n) => n + 1);

    const activeSessionId = sessionManager.getActiveSessionId();
    const nextMessages =
      activeSessionId && !busy ? loadVisibleMessages(sessionManager, activeSessionId) : messagesRef.current;
    setTimeout(() => {
      setMessages(nextMessages);
      setShowWelcome(true);
    }, 0);
  }, [busy, mode, sessionManager, columns, stdout]);

  const screenWidth = useMemo(() => columns ?? stdout?.columns ?? 80, [columns, stdout]);
  const screenHeight = useMemo(() => rows ?? stdout?.rows ?? 24, [rows, stdout]);
  const promptHistory = useMemo(() => {
    return messages
      .filter((message) => message.role === "user" && typeof message.content === "string")
      .map((message) => (message.content ?? "").trim())
      .filter((content) => content.length > 0);
  }, [messages]);
  const expandedThinkingId = findExpandedThinkingId(messages);
  const pendingQuestion = useMemo(
    () => findPendingAskUserQuestion(messages, activeEntry?.status ?? null),
    [activeEntry?.status, messages]
  );
  const shouldShowQuestionPrompt = Boolean(pendingQuestion && !dismissedQuestionIds.has(pendingQuestion.messageId));
  const activePlan = activeEntry?.workflow.plan ?? null;
  const activePlanDismissalKey =
    activeEntry && activePlan ? `${activeEntry.id}:${activePlan.planId}:${activePlan.revision}` : null;
  const shouldShowPlanHandoff = Boolean(
    activeEntry?.workflow.mode === WORKFLOW_MODE.PLAN &&
    activePlan?.status === PLAN_STATUS.READY &&
    activePlanDismissalKey &&
    !dismissedPlanRevisions.has(activePlanDismissalKey)
  );
  const currentWorkflowMode = activeEntry?.workflow.mode ?? pendingWorkflowMode;
  const loadingText = useMemo(
    () => (busy ? buildLoadingText({ progress: streamProgress, processes: runningProcesses, now: Date.now() }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nowTick forces periodic recalculation for spinner animation
    [busy, streamProgress, runningProcesses, nowTick]
  );
  const chatStatus = useMemo(
    () =>
      buildChatStatus({
        error: errorLine,
        waitingForUser: shouldShowQuestionPrompt,
        busy,
        loadingText,
        entry: activeEntry,
      }),
    [activeEntry, busy, errorLine, loadingText, shouldShowQuestionPrompt]
  );

  const welcomeItem: SessionMessage = useMemo(
    () => ({
      id: `__welcome__${welcomeNonce}`,
      sessionId: "",
      role: "system",
      content: "",
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: "",
      updateTime: "",
    }),
    [welcomeNonce]
  );
  const staticItems = useMemo(() => {
    if (mode === RawMode.Raw) {
      return [];
    }
    if (showWelcome && view === "chat") {
      return [welcomeItem, ...messages];
    }
    return messages;
  }, [mode, showWelcome, view, messages, welcomeItem]);

  const resumePromptQueueAfterQuestion = useCallback((): void => {
    const sessionId = sessionManager.getActiveSessionId();
    if (sessionId && sessionManager.getSession(sessionId)?.status === "completed") {
      promptQueueRef.current?.resume();
    }
  }, [sessionManager]);

  const handleQuestionAnswers = useCallback(
    (answers: AskUserQuestionAnswers) => {
      promptQueueRef.current?.pause();
      void handlePrompt({ text: formatAskUserQuestionAnswers(answers), imageUrls: [] }).finally(
        resumePromptQueueAfterQuestion
      );
    },
    [handlePrompt, resumePromptQueueAfterQuestion]
  );

  const handleQuestionCancel = useCallback(() => {
    if (!pendingQuestion) {
      return;
    }
    setDismissedQuestionIds((prev) => new Set(prev).add(pendingQuestion.messageId));
    promptQueueRef.current?.pause();
    void handlePrompt({ text: formatAskUserQuestionDecline(), imageUrls: [] }).finally(resumePromptQueueAfterQuestion);
  }, [handlePrompt, pendingQuestion, resumePromptQueueAfterQuestion]);

  if (mode === RawMode.Raw) {
    return <RawModeExitPrompt onExit={(prev) => handleRawModeChange(prev)} />;
  }

  return (
    <Box flexDirection="column" width={screenWidth} overflowX={"visible"}>
      <Static items={staticItems}>
        {(item) => {
          if (item.id.startsWith("__welcome__")) {
            return (
              <WelcomeScreen
                key={item.id}
                projectRoot={projectRoot}
                settings={resolvedSettings}
                skills={skills}
                width={screenWidth}
              />
            );
          }
          return (
            <MessageView
              key={item.id}
              message={item}
              collapsed={isCollapsedThinking(item, expandedThinkingId)}
              width={screenWidth}
            />
          );
        }}
      </Static>
      {view === "chat" && chatStatus.kind === "error" ? (
        <Box marginLeft={1}>
          <StatusMessage variant="error">{chatStatus.text}</StatusMessage>
        </Box>
      ) : view === "chat" ? (
        <Box marginLeft={1} gap={1}>
          <Text color={chatStatusColor(chatStatus.kind)}>{chatStatusSymbol(chatStatus.kind)}</Text>
          <Text dimColor>{chatStatus.text}</Text>
        </Box>
      ) : null}
      {view === "chat" && queuedPrompts.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {queuedPrompts.map((queuedPrompt) => (
            <Box key={queuedPrompt.id} gap={1}>
              <Text color="gray">Queued</Text>
              <Text dimColor wrap="wrap">
                {formatQueuedPrompt(queuedPrompt.submission)}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
      {showProcessStdout ? (
        <ProcessStdoutView
          processStdoutRef={processStdoutRef}
          runningProcesses={runningProcesses}
          onDismiss={handleDismissProcessStdout}
          onAdjustTimeout={handleAdjustBashTimeout}
          screenWidth={screenWidth}
          screenHeight={screenHeight}
        />
      ) : view === "session-list" ? (
        <SessionList
          sessions={sessions}
          onSelect={(id) => void handleSelectSession(id)}
          onCancel={closeSecondaryView}
        />
      ) : view === "undo" ? (
        <UndoSelector
          targets={undoTargets}
          onSelect={(target, restoreMode) => void handleUndoRestore(target, restoreMode)}
          onCancel={() => {
            closeSecondaryView();
          }}
        />
      ) : view === "mcp-status" ? (
        <McpStatusList
          statuses={mcpStatuses}
          onCancel={closeSecondaryView}
          onReconnect={(name) => {
            const latest = resolveCurrentSettings(projectRoot);
            void sessionManager.reconnectMcpServer(name, latest.mcpServers?.[name]);
          }}
        />
      ) : view === "web-search-setup" ? (
        <WebSearchSetupScreen onComplete={handleWebSearchSetupComplete} onCancel={closeSecondaryView} />
      ) : shouldShowQuestionPrompt && pendingQuestion && !busy ? (
        <AskUserQuestionPrompt
          questions={pendingQuestion.questions}
          onSubmit={handleQuestionAnswers}
          onCancel={handleQuestionCancel}
        />
      ) : shouldShowPlanHandoff && activePlan && activePlanDismissalKey && !busy ? (
        <PlanHandoffPrompt
          revision={activePlan.revision}
          onImplement={() => handleSubmit({ text: "/build", imageUrls: [], command: "build" })}
          onKeepPlanning={() => {
            setDismissedPlanRevisions((current) => new Set(current).add(activePlanDismissalKey));
          }}
          onSwitchMode={() => handleWorkflowModeChange(getNextWorkflowMode(currentWorkflowMode))}
        />
      ) : isExiting ? null : (
        <PromptInput
          projectRoot={projectRoot}
          screenWidth={screenWidth}
          skills={skills}
          modelConfig={resolvedSettings}
          promptHistory={promptHistory}
          busy={busy}
          runningProcesses={runningProcesses}
          promptDraft={promptDraft}
          workflowMode={currentWorkflowMode}
          onSubmit={handleSubmit}
          onModelConfigChange={handleModelConfigChange}
          onRawModeChange={handleRawModeChange}
          onInterrupt={handleInterrupt}
          onWorkflowModeChange={handleWorkflowModeChange}
          onToggleProcessStdout={handleToggleProcessStdout}
          placeholder="Type your message..."
        />
      )}
    </Box>
  );
}

function isCollapsedThinking(message: SessionMessage, expandedId: string | null): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if (!message.meta?.asThinking) {
    return false;
  }
  return message.id !== expandedId;
}

function buildSyntheticUserMessage(content: string, imageCount: number): SessionMessage {
  const now = new Date().toISOString();
  return {
    id: `local-${Math.random().toString(36).slice(2)}`,
    sessionId: "local",
    role: "user",
    content,
    contentParams:
      imageCount > 0
        ? Array.from({ length: imageCount }, () => ({
            type: "image_url",
            image_url: { url: "" },
          }))
        : null,
    messageParams: null,
    compacted: false,
    visible: true,
    createTime: now,
    updateTime: now,
  };
}

export function formatQueuedPrompt(submission: PromptSubmission): string {
  const text = submission.text.trim();
  if (text) return text.replace(/\s+/g, " ");
  const skillNames = submission.selectedSkills?.map((skill) => skill.name).filter(Boolean) ?? [];
  if (skillNames.length > 0) return `Use skills: ${skillNames.join(", ")}`;
  const imageCount = submission.imageUrls.length;
  return imageCount === 1 ? "[1 image]" : `[${imageCount} images]`;
}

export function buildPromptDraftFromSessionMessage(message: SessionMessage, nonce: number): PromptDraft {
  return {
    nonce,
    text: typeof message.content === "string" ? message.content : "",
    imageUrls: extractImageUrlsFromContentParams(message.contentParams),
  };
}

function extractImageUrlsFromContentParams(contentParams: unknown): string[] {
  const params = Array.isArray(contentParams) ? contentParams : contentParams ? [contentParams] : [];
  const imageUrls: string[] = [];
  for (const param of params) {
    if (!param || typeof param !== "object") {
      continue;
    }
    const record = param as { type?: unknown; image_url?: { url?: unknown } };
    const url = record.image_url?.url;
    if (record.type === "image_url" && typeof url === "string" && url) {
      imageUrls.push(url);
    }
  }
  return imageUrls;
}

function chatStatusColor(kind: ReturnType<typeof buildChatStatus>["kind"]): string {
  if (kind === "waiting") return "yellow";
  if (kind === "tool" || kind === "complete") return "green";
  if (kind === "reasoning") return "#6366f1";
  return "gray";
}

function chatStatusSymbol(kind: ReturnType<typeof buildChatStatus>["kind"]): string {
  if (kind === "waiting") return "?";
  if (kind === "tool") return "◆";
  if (kind === "reasoning") return "◎";
  if (kind === "complete") return "✓";
  if (kind === "stopped") return "■";
  return "·";
}

export function readSettings(): DeepcodingSettings | null {
  return readSettingsFile(getUserSettingsPath());
}

export function readProjectSettings(projectRoot: string = process.cwd()): DeepcodingSettings | null {
  return readSettingsFile(getProjectSettingsPath(projectRoot));
}

function readSettingsFile(settingsPath: string): DeepcodingSettings | null {
  try {
    if (!fs.existsSync(settingsPath)) {
      return null;
    }
    const raw = fs.readFileSync(settingsPath, "utf8");
    return JSON.parse(raw) as DeepcodingSettings;
  } catch {
    return null;
  }
}

export function writeSettings(settings: DeepcodingSettings): void {
  const settingsPath = getUserSettingsPath();
  writeSettingsFile(settingsPath, settings);
}

export function writeProjectSettings(settings: DeepcodingSettings, projectRoot: string = process.cwd()): void {
  const settingsPath = getProjectSettingsPath(projectRoot);
  writeSettingsFile(settingsPath, settings);
}

function writeSettingsFile(settingsPath: string, settings: DeepcodingSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function writeModelConfigSelection(
  selection: ModelConfigSelection,
  current: ModelConfigSelection = resolveCurrentSettings(),
  projectRoot: string = process.cwd()
): { changed: boolean; settings: DeepcodingSettings } {
  const projectSettingsPath = getProjectSettingsPath(projectRoot);
  const shouldWriteProjectSettings = fs.existsSync(projectSettingsPath);
  const rawSettings = shouldWriteProjectSettings ? readProjectSettings(projectRoot) : readSettings();
  const result = applyModelConfigSelection(rawSettings, current, selection);
  if (result.changed) {
    if (shouldWriteProjectSettings) {
      writeProjectSettings(result.settings, projectRoot);
    } else {
      writeSettings(result.settings);
    }
  }
  return result;
}

export function resolveCurrentSettings(projectRoot: string = process.cwd()): ResolvedDeepcodingSettings {
  const processEnv = { ...loadProjectEnv(projectRoot), ...process.env };
  return resolveSettingsSources(
    readSettings(),
    readProjectSettings(projectRoot),
    {
      model: DEFAULT_MODEL,
      baseURL: DEFAULT_BASE_URL,
    },
    processEnv
  );
}

export { createOpenAIClient } from "../common/openai-client";

function getUserSettingsPath(): string {
  return path.join(os.homedir(), ".doku", "settings.json");
}

function getProjectSettingsPath(projectRoot: string): string {
  return path.join(projectRoot, ".doku", "settings.json");
}

function formatThinkingMode(settings: Pick<ModelConfigSelection, "thinkingEnabled" | "reasoningEffort">): string {
  if (!settings.thinkingEnabled) {
    return "no thinking";
  }
  return `thinking ${settings.reasoningEffort}`;
}

function formatModelConfig(settings: ModelConfigSelection): string {
  return `${settings.model}, ${formatThinkingMode(settings)}`;
}
