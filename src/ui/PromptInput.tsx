import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useStdout } from "ink";
import chalk from "chalk";
import { ARGS_SEPARATOR } from "./constants";
import {
  EMPTY_BUFFER,
  PASTE_MARKER_REGEX,
  backspace,
  cleanPasteContent,
  deleteForward,
  deletePasteMarkerBackward,
  deletePasteMarkerForward,
  deleteWordBefore,
  deleteWordAfter,
  expandPasteMarkers,
  findPasteMarkerContaining,
  getCurrentSlashToken,
  hasActivePasteMarkers,
  insertText,
  isEmpty,
  killLine,
  moveDown,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveWordLeft,
  moveWordRight,
  moveUp,
} from "./promptBuffer";
import type { PromptBufferState } from "./promptBuffer";
import {
  clearPromptUndoRedoState,
  createPromptUndoRedoState,
  recordPromptEdit,
  redoPromptEdit,
  undoPromptEdit,
} from "./promptUndoRedo";
import { buildSlashCommands, filterSlashCommands, findExactSlashCommand } from "./slashCommands";
import { getBuiltinWorkflowSkillByName } from "../common/builtin-skills";
import type { SlashCommandItem } from "./slashCommands";
import {
  filterFileMentionItems,
  getCurrentFileMentionToken,
  replaceCurrentFileMentionToken,
  scanFileMentionItems,
} from "./fileMentions";
import type { FileMentionItem } from "./fileMentions";
import { readClipboardImageAsync } from "./clipboard";
import type { SessionEntry, SkillInfo } from "../session";
import { WORKFLOW_MODE, type WorkflowMode } from "../session/types";
import { UI_COLOR } from "./theme";

// Re-exported from prompt modules for backward compatibility
export { useTerminalInput, parseTerminalInput, dispatchTerminalInput } from "./prompt";
export type { InputKey } from "./prompt";

import { useTerminalInput } from "./prompt";
import type { InputKey } from "./prompt";
import {
  useHiddenTerminalCursor,
  useTerminalExtendedKeys,
  useBracketedPaste,
  useTerminalFocusReporting,
} from "./prompt";
import SlashCommandMenu, { isSkillSelected } from "./SlashCommandMenu";
import type { ModelConfigSelection } from "../settings";
import { FileMentionMenu, ModelsDropdown, RawModelDropdown, SkillsDropdown } from "./components";
import { submitPromptSubmission, type PromptSubmission } from "./promptSubmission";

export type PromptDraft = {
  nonce: number;
  text: string;
  imageUrls: string[];
};

type Props = {
  projectRoot: string;
  skills: SkillInfo[];
  modelConfig: ModelConfigSelection;
  screenWidth: number;
  promptHistory: string[];
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  runningProcesses?: SessionEntry["processes"];
  promptDraft?: PromptDraft | null;
  workflowMode?: WorkflowMode;
  onSubmit: (submission: PromptSubmission) => boolean;
  onModelConfigChange: (selection: ModelConfigSelection) => string | Promise<string>;
  onRawModeChange?: (mode: string) => void;
  onInterrupt: () => void;
  onWorkflowModeChange: (mode: WorkflowMode) => void;
  onToggleProcessStdout?: () => void;
};

function KeyHint({ k, d }: { k: string; d: string }): React.ReactElement {
  return (
    <Box gap={1}>
      <Text backgroundColor="#1e293b" color="#94a3b8">
        {" "}
        {k}{" "}
      </Text>
      <Text dimColor>{d}</Text>
    </Box>
  );
}

const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const SPINNER_COLORS = ["#0ea5e9", "#6366f1", "#8b5cf6", "#a855f7", "#8b5cf6", "#6366f1"];

const PromptPrefixLine = React.memo(function PromptPrefixLine({
  busy,
  workflowMode,
}: {
  busy: boolean;
  workflowMode: WorkflowMode;
}): React.ReactElement {
  const [spinnerIndex, setSpinnerIndex] = useState(0);

  useEffect(() => {
    if (!busy) {
      setSpinnerIndex(0);
      return;
    }
    const timer = setInterval(() => {
      setSpinnerIndex((index) => (index + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, [busy]);

  const prefix = busy ? `${SPINNER_FRAMES[spinnerIndex]} ` : "❯ ";
  const color = busy
    ? (SPINNER_COLORS[spinnerIndex % SPINNER_COLORS.length] as Parameters<typeof Text>[0]["color"])
    : workflowMode === WORKFLOW_MODE.PLAN
      ? UI_COLOR.PLAN
      : UI_COLOR.BUILD;
  return <Text color={color}>{prefix}</Text>;
});

export const PromptInput = React.memo(function PromptInput({
  projectRoot,
  skills,
  modelConfig,
  screenWidth,
  promptHistory,
  busy,
  disabled,
  placeholder,
  runningProcesses,
  promptDraft,
  workflowMode = WORKFLOW_MODE.BUILD,
  onSubmit,
  onModelConfigChange,
  onInterrupt,
  onWorkflowModeChange,
  onToggleProcessStdout,
  onRawModeChange,
}: Props): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [buffer, setBuffer] = useState<PromptBufferState>(EMPTY_BUFFER);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<SkillInfo[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [pendingExit, setPendingExit] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [showSkillsDropdown, setShowSkillsDropdown] = useState(false);
  const [openRawModelDropdown, setOpenRawModelDropdown] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [fileMentionItems, setFileMentionItems] = useState<FileMentionItem[]>(() => scanFileMentionItems(projectRoot));
  const [dismissedFileMentionKey, setDismissedFileMentionKey] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const [draftBeforeHistory, setDraftBeforeHistory] = useState<string | null>(null);
  const [hasTerminalFocus, setHasTerminalFocus] = useState(true);
  const lastExitAt = React.useRef<number>(0);
  const undoRedoRef = React.useRef(createPromptUndoRedoState());
  const wasBusyRef = React.useRef(busy);
  const hadFileMentionTokenRef = React.useRef(false);
  const appliedDraftNonceRef = React.useRef<number | null>(null);
  const pastesRef = React.useRef<Map<number, string>>(new Map());
  const pasteCounterRef = React.useRef<number>(0);
  // Track expanded paste regions for toggle (Ctrl+O expand / collapse).
  const expandedRegionsRef = React.useRef<Map<number, { start: number; end: number; content: string; marker: string }>>(
    new Map()
  );

  const fileMentionToken = getCurrentFileMentionToken(buffer);
  const hasFileMentionToken = fileMentionToken !== null;
  const fileMentionKey = fileMentionToken ? `${fileMentionToken.start}:${fileMentionToken.query}` : null;
  const fileMentionMatches = React.useMemo(
    () => (fileMentionToken ? filterFileMentionItems(fileMentionItems, fileMentionToken.query) : []),
    [fileMentionItems, fileMentionToken]
  );
  const showFileMentionMenu =
    !showSkillsDropdown &&
    !showModelDropdown &&
    fileMentionToken !== null &&
    fileMentionKey !== dismissedFileMentionKey;
  const slashItems = React.useMemo(() => buildSlashCommands(skills), [skills]);
  const slashToken = getCurrentSlashToken(buffer);
  const slashMenu = React.useMemo(
    () =>
      showSkillsDropdown || showModelDropdown || showFileMentionMenu
        ? []
        : slashToken
          ? filterSlashCommands(slashItems, slashToken)
          : [],
    [showSkillsDropdown, showModelDropdown, showFileMentionMenu, slashToken, slashItems]
  );
  const showMenu = slashMenu.length > 0;
  const promptHistoryKey = React.useMemo(() => promptHistory.join("\0"), [promptHistory]);
  const hasRunningProcess = runningProcesses && runningProcesses.size > 0;
  const hasCollapsedMarkers = hasActivePasteMarkers(buffer.text, pastesRef.current);
  const hasExpandedRegions = expandedRegionsRef.current.size > 0;
  const processOrPasteHint = hasRunningProcess
    ? " · ctrl+o view output"
    : hasCollapsedMarkers
      ? " · ctrl+o expand"
      : hasExpandedRegions
        ? " · ctrl+o collapse"
        : "";
  useTerminalFocusReporting(stdout, !disabled);
  useTerminalExtendedKeys(stdout, !disabled);
  useBracketedPaste(stdout, !disabled);
  useHiddenTerminalCursor(stdout, !disabled);

  const refreshFileMentionItems = React.useCallback(() => {
    setFileMentionItems(scanFileMentionItems(projectRoot));
  }, [projectRoot]);

  useEffect(() => {
    refreshFileMentionItems();
  }, [refreshFileMentionItems]);

  useEffect(() => {
    if (wasBusyRef.current && !busy) {
      refreshFileMentionItems();
    }
    wasBusyRef.current = busy;
  }, [busy, refreshFileMentionItems]);

  useEffect(() => {
    if (hasFileMentionToken && !hadFileMentionTokenRef.current) {
      refreshFileMentionItems();
    }
    hadFileMentionTokenRef.current = hasFileMentionToken;
  }, [hasFileMentionToken, refreshFileMentionItems]);

  // Reset to first selectable item whenever the menu content changes or appears.
  // Intentionally omits menuIndex from deps so navigation (↑↓) doesn't re-trigger this.
  useEffect(() => {
    if (!showMenu) {
      setMenuIndex(0);
      return;
    }
    const first = slashMenu.findIndex((item) => item.kind !== "section");
    setMenuIndex(first !== -1 ? first : 0);
  }, [slashMenu, showMenu]);

  useEffect(() => {
    if (!fileMentionKey) {
      setDismissedFileMentionKey(null);
    }
  }, [fileMentionKey]);

  useEffect(() => {
    if (!statusMessage) {
      return;
    }
    const timer = setTimeout(() => setStatusMessage(null), 2500);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  useEffect(() => {
    if (!promptDraft || appliedDraftNonceRef.current === promptDraft.nonce) {
      return;
    }
    appliedDraftNonceRef.current = promptDraft.nonce;
    setBuffer({ text: promptDraft.text, cursor: promptDraft.text.length });
    setImageUrls(promptDraft.imageUrls);
    setSelectedSkills([]);
    setShowSkillsDropdown(false);
    setOpenRawModelDropdown(false);
    setHistoryCursor(-1);
    setDraftBeforeHistory(null);
    clearPromptUndoRedoState(undoRedoRef.current);
    pastesRef.current.clear();
    expandedRegionsRef.current.clear();
  }, [promptDraft]);

  useEffect(() => {
    setHistoryCursor(-1);
    setDraftBeforeHistory(null);
  }, [promptHistoryKey]);

  useTerminalInput(
    (input, key) => {
      if (key.focusIn) {
        setHasTerminalFocus(true);
        return;
      }
      if (key.focusOut) {
        setHasTerminalFocus(false);
        return;
      }

      if (disabled) {
        return;
      }

      if (key.shift && key.tab) {
        if (busy) {
          setStatusMessage("wait for the current response before switching modes");
          return;
        }
        setShowSkillsDropdown(false);
        setShowModelDropdown(false);
        setOpenRawModelDropdown(false);
        setDismissedFileMentionKey(fileMentionKey);
        setStatusMessage(null);
        const nextWorkflowMode = getNextWorkflowMode(workflowMode);
        setSelectedSkills((current) => reconcileWorkflowSkills(current, nextWorkflowMode));
        onWorkflowModeChange(nextWorkflowMode);
        return;
      }

      if (key.escape) {
        if (showFileMentionMenu) {
          return;
        }
        if (busy) {
          onInterrupt();
          setStatusMessage("Interrupting…");
        }
        return;
      }

      if (key.ctrl && (input === "o" || input === "O")) {
        if (runningProcesses && runningProcesses.size > 0 && onToggleProcessStdout) {
          onToggleProcessStdout();
        } else {
          expandPasteMarkerAtCursor();
        }
        return;
      }

      if (key.ctrl && (input === "d" || input === "D")) {
        if (!isEmpty(buffer)) {
          updateBuffer((s) => deleteForward(s));
        }
        return;
      }

      if (key.ctrl && (input === "c" || input === "C")) {
        if (busy) {
          onInterrupt();
          setStatusMessage("Interrupting…");
        } else if (!isEmpty(buffer)) {
          setBuffer(EMPTY_BUFFER);
          clearUndoRedoStacks();
          pastesRef.current.clear();
          expandedRegionsRef.current.clear();
        } else {
          const now = Date.now();
          if (pendingExit && now - lastExitAt.current < 2000) {
            exit();
            return;
          }
          lastExitAt.current = now;
          setPendingExit(true);
          setStatusMessage("press ctrl+c again to exit");
        }
        return;
      }

      if (pendingExit && (!key.ctrl || (input !== "c" && input !== "C"))) {
        setPendingExit(false);
      }

      if (openRawModelDropdown || showSkillsDropdown || showModelDropdown) {
        return;
      }

      if (historyCursor !== -1 && !key.upArrow && !key.downArrow) {
        exitHistoryBrowsing();
      }

      if (key.paste) {
        handlePaste(input);
        return;
      }

      if (key.ctrl && (input === "v" || input === "V")) {
        setStatusMessage("Reading clipboard...");
        readClipboardImageAsync()
          .then((image) => {
            if (image) {
              setImageUrls((prev) => [...prev, image.dataUrl]);
              setStatusMessage("Attached image from clipboard");
            } else {
              setStatusMessage("No image found in clipboard");
            }
          })
          .catch(() => {
            setStatusMessage("Failed to read clipboard");
          });
        return;
      }

      if (isClearImageAttachmentsShortcut(input, key)) {
        if (imageUrls.length > 0) {
          setImageUrls([]);
          setStatusMessage("Cleared attached images");
        } else {
          setStatusMessage("No attached images to clear");
        }
        return;
      }

      const noModifier = !key.shift && !key.ctrl && !key.meta;
      const returnAction = getPromptReturnKeyAction(key);
      const isPlainReturn = returnAction === "submit";

      if (showFileMentionMenu) {
        if (key.upArrow || key.downArrow || key.tab || returnAction === "submit") {
          return;
        }
      }

      if (showMenu) {
        if (key.upArrow) {
          setMenuIndex((idx) => nextSelectableIndex(idx, -1));
          return;
        }
        if (key.downArrow) {
          setMenuIndex((idx) => nextSelectableIndex(idx, 1));
          return;
        }
        if (key.tab || returnAction === "submit") {
          const selected = slashMenu[menuIndex];
          if (selected && selected.kind !== "section") {
            handleSlashSelection(selected);
            return;
          }
        }
      }

      if (busy && isPlainReturn && buffer.text.trimStart().startsWith("/")) {
        setStatusMessage("wait for the current response or press esc to interrupt");
        return;
      }

      if (returnAction === "newline") {
        updateBuffer((s) => insertText(s, "\n"));
        return;
      }

      if (returnAction === "submit") {
        submitCurrentBuffer();
        return;
      }

      if (key.delete) {
        updateBuffer((s) => deletePasteMarkerForward(s, pastesRef.current) ?? deleteForward(s));
        return;
      }

      if (key.backspace) {
        if (buffer.text === "" && selectedSkills.length > 0) {
          setSelectedSkills((prev) => prev.slice(0, -1));
          return;
        }
        updateBuffer((s) => deletePasteMarkerBackward(s, pastesRef.current) ?? backspace(s));
        return;
      }

      if ((key.ctrl || key.meta) && key.leftArrow) {
        updateBuffer((s) => moveWordLeft(s));
        return;
      }

      if ((key.ctrl || key.meta) && key.rightArrow) {
        updateBuffer((s) => moveWordRight(s));
        return;
      }

      if (key.leftArrow) {
        updateBuffer((s) => moveLeft(s));
        return;
      }

      if (key.rightArrow) {
        updateBuffer((s) => moveRight(s));
        return;
      }

      if (key.home) {
        updateBuffer((s) => moveLineStart(s));
        return;
      }

      if (key.end) {
        updateBuffer((s) => moveLineEnd(s));
        return;
      }

      if (key.upArrow) {
        if (noModifier && (historyCursor !== -1 || buffer.cursor === 0) && promptHistory.length > 0) {
          navigateHistory(-1);
          return;
        }
        updateBuffer((s) => moveUp(s));
        return;
      }

      if (key.downArrow) {
        if (noModifier && (historyCursor !== -1 || buffer.cursor === buffer.text.length)) {
          navigateHistory(1);
          return;
        }
        updateBuffer((s) => moveDown(s));
        return;
      }

      if (key.ctrl && (input === "p" || input === "P")) {
        navigateHistory(-1);
        return;
      }
      if (key.ctrl && (input === "n" || input === "N")) {
        navigateHistory(1);
        return;
      }
      if (key.ctrl && (input === "a" || input === "A")) {
        updateBuffer((s) => moveLineStart(s));
        return;
      }
      if (key.ctrl && (input === "e" || input === "E")) {
        updateBuffer((s) => moveLineEnd(s));
        return;
      }
      if (key.ctrl && (input === "b" || input === "B")) {
        updateBuffer((s) => moveLeft(s));
        return;
      }
      if (key.ctrl && (input === "f" || input === "F")) {
        updateBuffer((s) => moveRight(s));
        return;
      }
      if (key.meta && (input === "b" || input === "B")) {
        updateBuffer((s) => moveWordLeft(s));
        return;
      }
      if (key.meta && (input === "f" || input === "F")) {
        updateBuffer((s) => moveWordRight(s));
        return;
      }
      if (key.ctrl && (input === "k" || input === "K")) {
        updateBuffer((s) => killLine(s));
        return;
      }
      if (key.ctrl && (input === "u" || input === "U")) {
        updateBuffer(() => EMPTY_BUFFER);
        pastesRef.current.clear();
        expandedRegionsRef.current.clear();
        return;
      }
      if (key.ctrl && (input === "w" || input === "W")) {
        updateBuffer((s) => deleteWordBefore(s));
        return;
      }
      if (key.meta && (input === "d" || input === "D")) {
        updateBuffer((s) => deleteWordAfter(s));
        return;
      }
      if (key.meta && (input === "\u007F" || input === "\b")) {
        updateBuffer((s) => deleteWordBefore(s));
        return;
      }
      if (key.ctrl && (input === "j" || input === "J")) {
        updateBuffer((s) => insertText(s, "\n"));
        return;
      }
      if (key.ctrl && key.shift && input === "-") {
        redo();
        return;
      }
      if (key.ctrl && input === "-") {
        undo();
        return;
      }
      if (input.startsWith("\u001B")) {
        // Unhandled escape sequence (e.g. function keys); ignore to avoid inserting garbage.
        return;
      }

      if (input && !key.ctrl && !key.meta) {
        // Normalize line endings from paste: \r\n (Windows) → \n, \r (old macOS/Enter) → \n.
        // This preserves multi-line formatting when the user pastes content.
        const sanitized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        updateBuffer((s) => insertText(s, sanitized));
      }
    },
    { isActive: !disabled }
  );

  function undo(): void {
    const previous = undoPromptEdit(undoRedoRef.current, buffer);
    if (!previous) {
      return;
    }
    exitHistoryBrowsing();
    setBuffer(previous);
  }

  function redo(): void {
    const next = redoPromptEdit(undoRedoRef.current, buffer);
    if (!next) {
      return;
    }
    exitHistoryBrowsing();
    setBuffer(next);
  }

  function clearUndoRedoStacks(): void {
    clearPromptUndoRedoState(undoRedoRef.current);
  }

  function exitHistoryBrowsing(): void {
    setHistoryCursor(-1);
    setDraftBeforeHistory(null);
  }

  function updateBuffer(updater: (state: PromptBufferState) => PromptBufferState): void {
    exitHistoryBrowsing();
    setBuffer((current) => {
      const next = updater(current);
      recordPromptEdit(undoRedoRef.current, current, next);
      return next;
    });
  }

  function handlePaste(pastedText: string): void {
    const totalChars = pastedText.length;

    if (totalChars <= 1000) {
      const newlineCount = (pastedText.match(/\n/g) ?? []).length;
      if (newlineCount <= 9) {
        const clean = pastedText
          .replace(/\r\n|\r/g, "\n")
          .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
          .replace(/\t/g, "    ");
        updateBuffer((s) => insertText(s, clean));
        return;
      }
    }

    // Large paste: store raw text, insert marker with line/char count.
    const lineCount = (pastedText.match(/\n/g) ?? []).length + 1;
    pasteCounterRef.current += 1;
    const pasteId = pasteCounterRef.current;
    pastesRef.current.set(pasteId, pastedText);

    const marker =
      lineCount > 10 ? `[paste #${pasteId} +${lineCount} lines]` : `[paste #${pasteId} ${totalChars} chars]`;

    updateBuffer((s) => insertText(s, marker));
  }

  function expandPasteMarkerAtCursor(): void {
    // First, try to collapse an already-expanded region at the cursor.
    for (const [id, region] of expandedRegionsRef.current) {
      if (buffer.cursor >= region.start && buffer.cursor <= region.end) {
        // Collapse back to marker.
        expandedRegionsRef.current.delete(id);
        pastesRef.current.set(id, region.content);
        setTimeout(() => {
          updateBuffer((s) => {
            const text = s.text.slice(0, region.start) + region.marker + s.text.slice(region.end);
            return { text, cursor: region.start + region.marker.length };
          });
        }, 0);
        return;
      }
    }

    // No expanded region at cursor — try to expand a paste marker.
    const marker = findPasteMarkerContaining(buffer);
    if (!marker) {
      setStatusMessage("No paste marker at cursor");
      return;
    }
    const content = pastesRef.current.get(marker.id);
    if (!content) {
      setStatusMessage("Paste content not found");
      return;
    }

    const pasteId = marker.id;
    const originalMarker = buffer.text.slice(marker.start, marker.end);
    pastesRef.current.delete(pasteId);

    setTimeout(() => {
      updateBuffer((s) => {
        const text = s.text.slice(0, marker.start) + cleanPasteContent(content) + s.text.slice(marker.end);
        const newEnd = marker.start + content.length;
        expandedRegionsRef.current.set(pasteId, {
          start: marker.start,
          end: newEnd,
          content,
          marker: originalMarker,
        });
        return { text, cursor: marker.start };
      });
    }, 0);
  }

  function navigateHistory(direction: -1 | 1): void {
    if (promptHistory.length === 0) {
      return;
    }

    const previousCursor = historyCursor === -1 ? promptHistory.length : historyCursor;
    const nextCursor = Math.max(0, Math.min(promptHistory.length, previousCursor + direction));
    const draft = historyCursor === -1 ? buffer.text : draftBeforeHistory;

    if (historyCursor === -1) {
      setDraftBeforeHistory(buffer.text);
    }

    if (nextCursor === promptHistory.length) {
      const text = draft ?? "";
      setBuffer({ text, cursor: text.length });
      setHistoryCursor(-1);
      setDraftBeforeHistory(null);
      return;
    }

    const text = promptHistory[nextCursor] ?? "";
    setBuffer({ text, cursor: text.length });
    setHistoryCursor(nextCursor);
  }

  function insertFileMentionSelection(item: FileMentionItem): void {
    if (!fileMentionToken) {
      return;
    }
    updateBuffer((state) => replaceCurrentFileMentionToken(state, fileMentionToken, item.path));
    setDismissedFileMentionKey(null);
  }

  function resetPromptInput(): void {
    setBuffer(EMPTY_BUFFER);
    clearUndoRedoStacks();
    setImageUrls([]);
    setSelectedSkills([]);
    setShowSkillsDropdown(false);
    pastesRef.current.clear();
    expandedRegionsRef.current.clear();
    pasteCounterRef.current = 0;
  }

  function submitAndReset(submission: PromptSubmission, reset: () => void = resetPromptInput): boolean {
    const accepted = submitPromptSubmission(submission, onSubmit, reset);
    if (!accepted) {
      setStatusMessage("Prompt queue is full; your draft was kept");
    }
    return accepted;
  }

  function nextSelectableIndex(from: number, direction: 1 | -1): number {
    const len = slashMenu.length;
    let idx = (from + direction + len) % len;
    let guard = 0;
    while (slashMenu[idx]?.kind === "section" && guard < len) {
      idx = (idx + direction + len) % len;
      guard++;
    }
    return idx;
  }

  function handleSlashSelection(item: SlashCommandItem): void {
    if (item.kind === "section") return;
    if (busy && item.kind !== "exit") {
      setStatusMessage("wait for the current response or press esc to interrupt");
      return;
    }

    if (item.kind === "skill" && item.skill) {
      addSelectedSkill(item.skill);
      clearSlashToken();
      setShowSkillsDropdown(false);
      return;
    }
    if (item.kind === "workflow" && item.skill) {
      if (item.workflowMode === WORKFLOW_MODE.BUILD) {
        submitAndReset({ text: "/build", imageUrls: [], command: "build" });
        return;
      }
      if (item.workflowMode) onWorkflowModeChange(item.workflowMode);
      clearSlashToken();
      setShowSkillsDropdown(false);
      return;
    }
    if (item.kind === "skills") {
      clearSlashToken();
      setShowSkillsDropdown(true);
      return;
    }
    if (item.kind === "model") {
      clearSlashToken();
      setShowSkillsDropdown(false);
      setShowModelDropdown(true);
      return;
    }
    if (item.kind === "raw") {
      clearSlashToken();
      setOpenRawModelDropdown(true);
      return;
    }
    if (item.kind === "new") {
      submitAndReset({ text: "", imageUrls: [], command: "new" });
      return;
    }
    if (item.kind === "init") {
      submitAndReset(buildInitPromptSubmission(reconcileWorkflowSkills(selectedSkills, workflowMode), workflowMode));
      return;
    }
    if (item.kind === "resume") {
      submitAndReset({ text: "", imageUrls: [], command: "resume" });
      return;
    }
    if (item.kind === "undo") {
      submitAndReset({ text: "/undo", imageUrls: [], command: "undo" });
      return;
    }
    if (item.kind === "mcp") {
      submitAndReset({ text: "/mcp", imageUrls: [], command: "mcp" });
      return;
    }
    if (item.kind === "exit") {
      submitAndReset({ text: "/exit", imageUrls: [], command: "exit" }, () => {
        setBuffer(EMPTY_BUFFER);
        clearUndoRedoStacks();
      });
      return;
    }
    if (item.kind === "setup-websearch") {
      submitAndReset({ text: "", imageUrls: [], command: "setup-websearch" });
      return;
    }
  }

  function submitCurrentBuffer(): void {
    const trimmed = buffer.text.trim();
    const submissionSkills = reconcileWorkflowSkills(selectedSkills, workflowMode);
    if (!trimmed && imageUrls.length === 0 && submissionSkills.length === 0) {
      return;
    }

    if (busy && trimmed.startsWith("/")) {
      setStatusMessage("wait for the current response or press esc to interrupt");
      return;
    }

    if (trimmed.startsWith("/")) {
      const exactMatch = findExactSlashCommand(slashItems, trimmed.split(/\s+/, 1)[0]);
      if (exactMatch) {
        const workflowPromptSubmission = buildWorkflowPromptSubmission(
          exactMatch,
          expandPasteMarkers(buffer.text, pastesRef.current),
          imageUrls,
          submissionSkills
        );
        if (workflowPromptSubmission) {
          submitAndReset(workflowPromptSubmission);
          return;
        }
        const skillPromptSubmission = buildSkillPromptSubmission(
          exactMatch,
          expandPasteMarkers(buffer.text, pastesRef.current),
          imageUrls,
          submissionSkills
        );
        if (skillPromptSubmission) {
          submitAndReset(skillPromptSubmission);
          return;
        }
        handleSlashSelection(exactMatch);
        return;
      }
    }

    const accepted = submitAndReset({
      text: expandPasteMarkers(buffer.text, pastesRef.current),
      imageUrls,
      selectedSkills: submissionSkills,
      workflowMode,
    });
    if (accepted && busy) setStatusMessage("Queued for the next turn");
  }

  function addSelectedSkill(skill: SkillInfo): void {
    setSelectedSkills((prev) => addUniqueSkill(prev, skill));
  }

  function toggleSelectedSkill(skill: SkillInfo): void {
    setSelectedSkills((prev) => toggleSkillSelection(prev, skill));
  }

  function clearSlashToken(): void {
    exitHistoryBrowsing();
    setBuffer((state) => removeCurrentSlashToken(state));
    clearUndoRedoStacks();
  }

  const showFooterText = useMemo(
    () => showMenu || showSkillsDropdown || openRawModelDropdown || showModelDropdown || showFileMentionMenu,
    [showMenu, showSkillsDropdown, showModelDropdown, openRawModelDropdown, showFileMentionMenu]
  );

  const matchedCommand = slashToken ? findExactSlashCommand(slashItems, slashToken) : null;
  const inlineHint = matchedCommand?.args ? ` ${matchedCommand.args.join(ARGS_SEPARATOR)}` : "";

  return (
    <Box flexDirection="column" width={screenWidth}>
      {imageUrls.length > 0 ? (
        <Box>
          <Text color="magenta">{formatImageAttachmentStatus(imageUrls.length)}</Text>
          <Text dimColor>{` (${IMAGE_ATTACHMENT_CLEAR_HINT})`}</Text>
        </Box>
      ) : null}
      {/* Input */}
      <Box
        borderStyle="round"
        borderColor={busy ? UI_COLOR.BUSY : workflowMode === WORKFLOW_MODE.PLAN ? UI_COLOR.PLAN : UI_COLOR.BUILD}
        paddingX={1}
      >
        {workflowMode === WORKFLOW_MODE.PLAN ? (
          <Text color={UI_COLOR.PLAN} bold>
            PLAN{" "}
          </Text>
        ) : null}
        <PromptPrefixLine busy={busy} workflowMode={workflowMode} />
        {selectedSkills.map((skill) => {
          const builtin = getBuiltinWorkflowSkillByName(skill.name);
          const label = builtin ? builtin.command : skill.name;
          return (
            <Text key={skill.name} color="#a855f7">
              [{label}]{" "}
            </Text>
          );
        })}
        <Text>{renderBufferWithCursor(buffer, !disabled && hasTerminalFocus, placeholder, pastesRef.current)}</Text>
        {inlineHint ? <Text dimColor>{inlineHint}</Text> : null}
      </Box>
      <RawModelDropdown
        open={openRawModelDropdown}
        onClose={setOpenRawModelDropdown}
        onSelect={(mode) => onRawModeChange?.(mode)}
        screenWidth={screenWidth}
      />
      <SkillsDropdown
        width={screenWidth}
        open={showSkillsDropdown}
        onClose={setShowSkillsDropdown}
        skills={skills}
        selectedSkills={selectedSkills}
        onSelect={toggleSelectedSkill}
      />
      <ModelsDropdown
        open={showModelDropdown}
        modelConfig={modelConfig}
        width={screenWidth}
        onClose={() => setShowModelDropdown(false)}
        onModelConfigChange={onModelConfigChange}
        onStatusMessage={setStatusMessage}
      />
      <FileMentionMenu
        open={showFileMentionMenu}
        width={screenWidth}
        token={fileMentionToken}
        items={fileMentionMatches}
        onClose={() => {
          if (fileMentionKey) {
            setDismissedFileMentionKey(fileMentionKey);
          }
        }}
        onSelect={insertFileMentionSelection}
      />
      <SlashCommandMenu width={screenWidth} items={slashMenu} activeIndex={menuIndex} />
      {!showFooterText &&
        (statusMessage ? (
          <Box paddingX={2}>
            <Text color="#0ea5e9">{statusMessage}</Text>
          </Box>
        ) : busy ? (
          <Box paddingX={2} gap={2} marginTop={0}>
            <Text dimColor>{`esc stop turn${processOrPasteHint}`}</Text>
          </Box>
        ) : (
          <Box paddingX={2} gap={3}>
            {getPromptFooterHints(screenWidth).map((hint) => (
              <KeyHint key={hint.k} k={hint.k} d={hint.d} />
            ))}
            {processOrPasteHint ? <Text dimColor>{processOrPasteHint}</Text> : null}
          </Box>
        ))}
    </Box>
  );
});

export function getPromptFooterHints(width: number): Array<{ k: string; d: string }> {
  const essential = [
    { k: "enter", d: "send" },
    { k: "/", d: "commands" },
    { k: "ctrl+c", d: "exit" },
  ];
  if (width < 80) return essential;
  const modeHint = { k: "shift+tab", d: "mode" };
  const standard = [...essential.slice(0, 2), modeHint, { k: "@", d: "files" }, essential[2]!];
  return width >= 120 ? [...standard.slice(0, -1), { k: "ctrl+v", d: "image" }, essential[2]!] : standard;
}

export function getNextWorkflowMode(mode: WorkflowMode): WorkflowMode {
  return mode === WORKFLOW_MODE.PLAN ? WORKFLOW_MODE.BUILD : WORKFLOW_MODE.PLAN;
}

export const IMAGE_ATTACHMENT_CLEAR_HINT = "ctrl+x clear images";

export function formatImageAttachmentStatus(count: number): string {
  if (count <= 0) {
    return "";
  }
  return `📎 ${count} image${count === 1 ? "" : "s"} attached`;
}

export function formatSelectedSkillsStatus(skills: SkillInfo[]): string {
  const names = skills.map((skill) => skill.name).filter(Boolean);
  if (names.length === 0) {
    return "";
  }
  return `⚡ ${names.join(", ")}`;
}

export function addUniqueSkill(skills: SkillInfo[], skill: SkillInfo): SkillInfo[] {
  if (isSkillSelected(skills, skill)) {
    return skills;
  }
  return [...skills, skill];
}

export function toggleSkillSelection(skills: SkillInfo[], skill: SkillInfo): SkillInfo[] {
  return isSkillSelected(skills, skill) ? skills.filter((item) => item.name !== skill.name) : [...skills, skill];
}

export function buildInitPromptSubmission(selectedSkills: SkillInfo[], workflowMode?: WorkflowMode): PromptSubmission {
  return {
    text: "/init",
    imageUrls: [],
    selectedSkills: selectedSkills.length > 0 ? selectedSkills : undefined,
    ...(workflowMode ? { workflowMode } : {}),
  };
}

export function buildSkillPromptSubmission(
  item: SlashCommandItem,
  text: string,
  imageUrls: string[],
  selectedSkills: SkillInfo[]
): PromptSubmission | null {
  if (item.kind !== "skill" || !item.skill) {
    return null;
  }

  const trimmedStart = text.trimStart();
  const commandToken = trimmedStart.split(/\s+/, 1)[0] ?? "";
  if (commandToken !== item.label) {
    return null;
  }

  const promptText = trimmedStart.slice(commandToken.length).trimStart();
  if (!promptText && imageUrls.length === 0) {
    return null;
  }

  return {
    text: promptText,
    imageUrls,
    selectedSkills: addUniqueSkill(selectedSkills, item.skill),
  };
}

export function buildWorkflowPromptSubmission(
  item: SlashCommandItem,
  text: string,
  imageUrls: string[],
  selectedSkills: SkillInfo[]
): PromptSubmission | null {
  if (item.kind !== "workflow" || !item.skill || !item.workflowMode) return null;
  const trimmedStart = text.trimStart();
  const commandToken = trimmedStart.split(/\s+/, 1)[0] ?? "";
  if (commandToken !== item.label) return null;
  const promptText = trimmedStart.slice(commandToken.length).trimStart();
  if (item.workflowMode === WORKFLOW_MODE.BUILD && !promptText && imageUrls.length === 0) {
    return { text: "/build", imageUrls: [], command: "build" };
  }
  if (!promptText && imageUrls.length === 0) return null;
  const workflowSkills =
    item.workflowMode === WORKFLOW_MODE.PLAN ? selectedSkills : addUniqueSkill(selectedSkills, item.skill);
  return {
    text: promptText,
    imageUrls,
    ...(workflowSkills.length > 0 ? { selectedSkills: workflowSkills } : {}),
    workflowMode: item.workflowMode,
  };
}

export function reconcileWorkflowSkills(skills: SkillInfo[], workflowMode: WorkflowMode): SkillInfo[] {
  return skills.filter((skill) => {
    const command = getBuiltinWorkflowSkillByName(skill.name)?.command;
    const isModeSkill = command === WORKFLOW_MODE.PLAN || command === WORKFLOW_MODE.BUILD;
    return !isModeSkill || command === workflowMode;
  });
}

export function removeCurrentSlashToken(state: PromptBufferState): PromptBufferState {
  let start = state.cursor;
  while (start > 0 && !/\s/.test(state.text[start - 1] ?? "")) {
    start -= 1;
  }

  const token = state.text.slice(start, state.cursor);
  if (!token.startsWith("/")) {
    return state;
  }

  const text = `${state.text.slice(0, start)}${state.text.slice(state.cursor)}`;
  return { text, cursor: start };
}

export function isClearImageAttachmentsShortcut(input: string, key: Pick<InputKey, "ctrl">): boolean {
  return key.ctrl && (input === "x" || input === "X");
}

export type PromptReturnKeyAction = "submit" | "newline" | null;

export function getPromptReturnKeyAction(key: Pick<InputKey, "return" | "shift" | "meta">): PromptReturnKeyAction {
  if (!key.return) {
    return null;
  }
  if (key.shift || key.meta) {
    return "newline";
  }
  return "submit";
}

export function renderBufferWithCursor(
  state: PromptBufferState,
  isFocused: boolean,
  placeholder?: string,
  validPastes?: Map<number, string>
): string {
  const text = state.text || "";
  const cursor = Math.max(0, Math.min(state.cursor, text.length));
  const validIds = validPastes ?? new Map<number, string>();

  if (text.length === 0 && placeholder) {
    if (!isFocused) {
      return chalk.dim(`  ${placeholder}`);
    }
    return renderCursorCell(" ") + chalk.dim(` ${placeholder}`);
  }

  if (text.length === 0) {
    return isFocused ? renderCursorCell(" ") : "";
  }

  if (!isFocused) {
    return highlightPasteMarkersInText(text, validIds);
  }

  return renderFocusedText(text, cursor, validIds);
}

function highlightPasteMarkersInText(s: string, validIds: Map<number, string>): string {
  if (!s.includes("[paste #")) return s;
  PASTE_MARKER_REGEX.lastIndex = 0;
  let result = "";
  let pos = 0;
  let match: RegExpExecArray | null;
  while ((match = PASTE_MARKER_REGEX.exec(s)) !== null) {
    result += s.slice(pos, match.index);
    const id = Number.parseInt(match[1]!, 10);
    result += validIds.has(id) ? chalk.yellow(match[0]) : match[0];
    pos = match.index + match[0].length;
  }
  result += s.slice(pos);
  return result.endsWith("\n") ? `${result} ` : result;
}

/**
 * Render focused text with paste-marker highlighting and cursor insertion.
 * Scans through the entire string in one pass, so the cursor can land
 * anywhere (including inside or at the boundary of a paste marker) and the
 * marker will still be highlighted correctly.
 */
function renderFocusedText(text: string, cursor: number, validIds: Map<number, string>): string {
  let result = "";
  let pos = 0;
  PASTE_MARKER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = PASTE_MARKER_REGEX.exec(text)) !== null) {
    const markerStart = match.index;
    const markerEnd = match.index + match[0].length;
    const id = Number.parseInt(match[1]!, 10);
    const isReal = validIds.has(id);

    // 1. Non-marker segment before this marker.
    result += renderTextSegmentWithCursor(text, pos, markerStart, cursor, false);
    pos = markerStart;

    // 2. Marker segment — highlighted only if it corresponds to a real paste.
    result += renderTextSegmentWithCursor(text, pos, markerEnd, cursor, isReal);
    pos = markerEnd;
  }

  // 3. Remainder after the last marker.
  result += renderTextSegmentWithCursor(text, pos, text.length, cursor, false);

  return result;
}

/**
 * Render a segment of `text` from `start` to `end`.
 * The cursor (if it falls inside this segment) is rendered as an inverse-video cell.
 */
function renderTextSegmentWithCursor(
  text: string,
  start: number,
  end: number,
  cursor: number,
  highlighted: boolean
): string {
  if (start >= end) return "";

  const segText = text.slice(start, end);
  const cursorRel = cursor - start; // relative cursor position inside this segment

  // Cursor not in this segment – just return the text.
  if (cursorRel < 0 || cursorRel > segText.length) {
    return highlighted ? chalk.yellow(segText) : segText;
  }

  // Cursor is exactly at `end` (which equals `segText.length`).
  if (cursorRel === segText.length) {
    return highlighted ? chalk.yellow(segText) + renderCursorCell(" ") : segText + renderCursorCell(" ");
  }

  // Cursor is somewhere inside the segment.
  const at = segText[cursorRel];

  if (at === "\n") {
    // Render newline as a space in the cursor cell, then output the actual newline.
    const before = segText.slice(0, cursorRel);
    const after = segText.slice(cursorRel + 1);
    return before + renderCursorCell(" ") + "\n" + after;
  }

  const before = segText.slice(0, cursorRel);
  const after = segText.slice(cursorRel + 1);
  if (highlighted) {
    return chalk.yellow(before) + renderCursorCell(at) + chalk.yellow(after);
  }
  return before + renderCursorCell(at) + after;
}

// Use explicit ANSI instead of chalk.inverse so cursor rendering stays enabled
// in non-TTY environments such as tests, where Chalk may strip styling.
function renderCursorCell(value: string): string {
  return `\u001B[7m${value}\u001B[27m`;
}
