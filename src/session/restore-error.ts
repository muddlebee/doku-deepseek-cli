export class SessionRestoreError extends Error {
  constructor(
    message: string,
    readonly codeRestored: boolean,
    readonly conversationRestored: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SessionRestoreError";
  }
}
