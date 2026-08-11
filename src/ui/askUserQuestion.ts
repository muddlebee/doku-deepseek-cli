import type { SessionMessage, SessionStatus } from "../session";

export type AskUserQuestionOption = {
  label: string;
  description?: string;
};

export type AskUserQuestionItem = {
  question: string;
  multiSelect?: boolean;
  options: AskUserQuestionOption[];
};

export type PendingAskUserQuestion = {
  messageId: string;
  sessionId: string;
  questions: AskUserQuestionItem[];
};

export type AskUserQuestionAnswers = Record<string, string>;

export function findPendingAskUserQuestion(
  messages: SessionMessage[],
  status: SessionStatus | null
): PendingAskUserQuestion | null {
  if (status !== "waiting_for_user") {
    return null;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "tool" || message.visible === false) {
      continue;
    }
    const questions = parseAskUserQuestionContent(message.content);
    if (questions.length === 0) {
      continue;
    }
    return {
      messageId: message.id,
      sessionId: message.sessionId,
      questions,
    };
  }

  return null;
}

export function formatAskUserQuestionAnswers(answers: AskUserQuestionAnswers): string {
  const answersText = Object.entries(answers)
    .map(([question, answer]) => `"${escapeAnswerPart(question)}"="${escapeAnswerPart(answer)}"`)
    .join(", ");
  return `Answers to your questions: ${answersText}. Continue with these answers.`;
}

export function formatAskUserQuestionDecline(): string {
  return "User declined to answer. Continue with available context; ask again only if required.";
}

function parseAskUserQuestionContent(content: string | null): AskUserQuestionItem[] {
  if (!content) {
    return [];
  }

  try {
    const parsed = JSON.parse(content) as { awaitUserResponse?: unknown; metadata?: unknown };
    if (parsed.awaitUserResponse !== true) {
      return [];
    }
    const metadata = parsed.metadata as { kind?: unknown; questions?: unknown } | null;
    if (!metadata || metadata.kind !== "ask_user_question") {
      return [];
    }
    return normalizeQuestions(metadata.questions);
  } catch {
    return [];
  }
}

function normalizeQuestions(raw: unknown): AskUserQuestionItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const questions: AskUserQuestionItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const question =
      typeof (item as { question?: unknown }).question === "string"
        ? (item as { question: string }).question.trim()
        : "";
    const rawOptions = (item as { options?: unknown }).options;
    if (!question || !Array.isArray(rawOptions) || rawOptions.length === 0) {
      continue;
    }
    const options: AskUserQuestionOption[] = rawOptions
      .map((option) => normalizeOption(option))
      .filter((option): option is AskUserQuestionOption => Boolean(option));
    if (options.length === 0) {
      continue;
    }
    const multiSelect =
      typeof (item as { multiSelect?: unknown }).multiSelect === "boolean"
        ? (item as { multiSelect: boolean }).multiSelect
        : undefined;
    questions.push({ question, multiSelect, options });
  }
  return questions;
}

function normalizeOption(raw: unknown): AskUserQuestionOption | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const label = typeof (raw as { label?: unknown }).label === "string" ? (raw as { label: string }).label.trim() : "";
  if (!label) {
    return null;
  }
  const description =
    typeof (raw as { description?: unknown }).description === "string"
      ? (raw as { description: string }).description.trim()
      : "";
  return {
    label,
    description: description || undefined,
  };
}

function escapeAnswerPart(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").trim();
}
