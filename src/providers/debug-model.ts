import type { Model, ModelRequest, ModelResponse, ResponseStreamEvent } from "@openai/agents";
import { logOpenAIChatCompletionDebug, normalizeDebugError } from "../common/debug-logger";

export function withModelDebugLogging(
  model: Model,
  options: { model: string; baseURL?: string; enabled?: boolean }
): Model {
  if (!options.enabled) return model;

  return {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      const startedAt = Date.now();
      try {
        const response = await model.getResponse(request);
        writeDebugEntry("agents:model.getResponse", request, startedAt, options, response);
        return response;
      } catch (error) {
        writeDebugEntry("agents:model.getResponse", request, startedAt, options, undefined, undefined, error);
        throw error;
      }
    },

    async *getStreamedResponse(request: ModelRequest): AsyncIterable<ResponseStreamEvent> {
      const startedAt = Date.now();
      const responseChunks: ResponseStreamEvent[] = [];
      try {
        for await (const event of model.getStreamedResponse(request)) {
          responseChunks.push(event);
          yield event;
        }
        writeDebugEntry("agents:model.getStreamedResponse", request, startedAt, options, undefined, responseChunks);
      } catch (error) {
        writeDebugEntry(
          "agents:model.getStreamedResponse",
          request,
          startedAt,
          options,
          undefined,
          responseChunks,
          error
        );
        throw error;
      }
    },

    ...(model.getRetryAdvice ? { getRetryAdvice: model.getRetryAdvice.bind(model) } : {}),
  };
}

function writeDebugEntry(
  location: string,
  request: ModelRequest,
  startedAt: number,
  options: { model: string; baseURL?: string },
  response?: ModelResponse,
  responseChunks?: ResponseStreamEvent[],
  error?: unknown
): void {
  logOpenAIChatCompletionDebug({
    timestamp: new Date().toISOString(),
    location,
    model: options.model,
    baseURL: options.baseURL,
    durationMs: Date.now() - startedAt,
    request: request as unknown as Record<string, unknown>,
    ...(response?.requestId ? { requestId: response.requestId } : {}),
    ...(response ? { response } : {}),
    ...(responseChunks ? { responseChunks } : {}),
    ...(error ? { error: normalizeDebugError(error) } : {}),
  });
}
