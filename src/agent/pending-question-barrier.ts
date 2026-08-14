export const PENDING_QUESTION_FINALIZE_ERROR =
  "The plan cannot be finalized while a user question is pending. Wait for the answer, update the plan, and finalize it again.";

export class PendingQuestionBarrier {
  private questionPending = false;

  async registerTool(requiresQuestionApproval: boolean): Promise<boolean> {
    if (requiresQuestionApproval) this.questionPending = true;
    // Agents JS starts sibling approval policies before awaiting them, so one yield lets every call register first.
    await Promise.resolve();
    return requiresQuestionApproval;
  }

  getFinalizationRejection(): string | undefined {
    return this.questionPending ? PENDING_QUESTION_FINALIZE_ERROR : undefined;
  }
}
