import { Injectable, Logger } from "@nestjs/common";
import {
  LlmChatMessage,
  LlmProvider,
  LlmToolCall,
  ProviderChatChoice,
  ProviderChatRequest,
} from "../llm-provider.contract";

/**
 * OpenAI-совместимый провайдер: один POST /chat/completions (stream и non-stream).
 * Конфигурация через env: LLM_BASE_URL, LLM_MODEL, LLM_API_KEY, LLM_TIMEOUT_MS,
 * LLM_TEMPERATURE, LLM_MAX_TOKENS. Транспорт изолирован от оркестрации (LlmService):
 * tool-loop, fallback'и и «пустой ответ → null» живут там, тут — только запрос+парсинг.
 */
@Injectable()
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = "openai-compatible";
  private readonly logger = new Logger(OpenAiCompatibleProvider.name);

  async chat(request: ProviderChatRequest): Promise<ProviderChatChoice | null> {
    const baseUrl = process.env.LLM_BASE_URL;
    const model = process.env.LLM_MODEL;
    const apiKey = process.env.LLM_API_KEY;

    const maxTokens = this.resolveMaxTokens(request.maxTokens);
    const temperature = this.resolveTemperature(request.temperature);
    const tools = request.tools;
    const useStream = typeof request.onTextDelta === "function";

    const url = `${baseUrl}/chat/completions`;
    const body: Record<string, unknown> = {
      model,
      messages: request.messages,
      temperature,
    };
    if (maxTokens !== undefined && maxTokens > 0) {
      body.max_tokens = maxTokens;
    }
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = "auto";
    }
    if (useStream) {
      body.stream = true;
      // Стандартная OpenAI-опция: usage в финальном chunk при stream.
      body.stream_options = { include_usage: true };
    }

    if (this.shouldLogLlmDev()) {
      const payload = this.formatMessagesForDevLog(request.messages);
      this.logger.debug(
        `LLM → ${url} model=${model} messages=${request.messages.length} temperature=${temperature}` +
          (maxTokens != null ? ` max_tokens=${maxTokens}` : "") +
          (tools && tools.length > 0 ? ` tools=${tools.length}` : "") +
          (useStream ? " stream=true" : "") +
          `\n${JSON.stringify(payload, null, 2)}`,
      );
    }

    const timeoutRaw = process.env.LLM_TIMEOUT_MS?.trim();
    const timeoutMs = timeoutRaw !== undefined && timeoutRaw !== "" ? Number(timeoutRaw) : 0;
    const signal =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        this.logger.warn(`LLM HTTP ${response.status}: ${errText}`);
        return null;
      }

      if (useStream) {
        return this.parseStreamingResponse(response, model, request.onTextDelta);
      }
      return this.parseNonStreamingResponse(response, model);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        this.logger.warn(
          `LLM request aborted (timeout LLM_TIMEOUT_MS=${process.env.LLM_TIMEOUT_MS ?? "unset"})`,
        );
      } else {
        this.logger.warn(`LLM request failed: ${error}`);
      }
      return null;
    }
  }

  private async parseNonStreamingResponse(
    response: Response,
    fallbackModel: string | undefined,
  ): Promise<ProviderChatChoice | null> {
    const data = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: LlmToolCall[] };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      model?: string;
    };
    const first = data.choices?.[0];
    const rawText = first?.message?.content;
    const text = typeof rawText === "string" ? rawText.trim() : undefined;
    const toolCalls = first?.message?.tool_calls;

    if (this.shouldLogLlmDev()) {
      if (toolCalls && toolCalls.length > 0) {
        this.logger.debug(
          `LLM ← tool_calls: ${toolCalls
            .map((t) => `${t.function.name}(${t.function.arguments})`)
            .join(", ")}`,
        );
      } else if (text) {
        const preview = text.length > 500 ? `${text.slice(0, 500)}… (${text.length} chars)` : text;
        this.logger.debug(`LLM ← reply preview:\n${preview}`);
      }
    }

    const usage =
      data.usage &&
      (data.usage.prompt_tokens !== undefined || data.usage.completion_tokens !== undefined)
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined;

    return {
      text,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      model: data.model ?? fallbackModel,
      finishReason: first?.finish_reason,
    };
  }

  /**
   * SSE-парсер OpenAI-совместимого streaming.
   * Накапливает content + tool_calls (по index), вызывает onTextDelta на каждом
   * новом content-куске. usage приходит в финальном chunk (stream_options.include_usage).
   */
  private async parseStreamingResponse(
    response: Response,
    fallbackModel: string | undefined,
    onTextDelta: ((text: string) => void | Promise<void>) | undefined,
  ): Promise<ProviderChatChoice | null> {
    if (!response.body) {
      this.logger.warn("LLM stream response has no body");
      return null;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const toolCallsByIndex = new Map<number, LlmToolCall>();
    let usage: ProviderChatChoice["usage"];
    let model: string | undefined;
    let finishReason: string | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line || !line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          let chunk: {
            choices?: Array<{
              delta?: {
                content?: string | null;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  type?: "function";
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string;
            }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
            };
            model?: string;
          };
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          if (chunk.model && !model) model = chunk.model;
          if (chunk.usage) {
            usage = {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            };
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta;
          if (!delta) continue;
          if (typeof delta.content === "string" && delta.content.length > 0) {
            text += delta.content;
            if (onTextDelta) {
              try {
                await onTextDelta(text);
              } catch (e) {
                this.logger.debug(
                  `onTextDelta threw: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            }
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const acc = toolCallsByIndex.get(idx) ?? {
                id: "",
                type: "function",
                function: { name: "", arguments: "" },
              };
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.function.name += tc.function.name;
              if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
              toolCallsByIndex.set(idx, acc);
            }
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }

    const toolCalls = [...toolCallsByIndex.values()].filter((tc) => tc.function.name);
    const trimmedText = text.trim();

    if (toolCallsByIndex.size > 0 && toolCalls.length === 0) {
      this.logger.warn(
        `LLM stream: ${toolCallsByIndex.size} tool_call-дельт с пустым именем — отброшены как битые ` +
          `(finish_reason=${finishReason ?? "?"}). Модель пыталась вызвать навык, но сформировала вызов некорректно.`,
      );
    }

    if (this.shouldLogLlmDev()) {
      if (toolCalls.length > 0) {
        this.logger.debug(
          `LLM ← (stream) tool_calls: ${toolCalls
            .map((t) => `${t.function.name}(${t.function.arguments})`)
            .join(", ")}`,
        );
      } else if (trimmedText) {
        const preview =
          trimmedText.length > 500
            ? `${trimmedText.slice(0, 500)}… (${trimmedText.length} chars)`
            : trimmedText;
        this.logger.debug(`LLM ← (stream) reply preview:\n${preview}`);
      }
    }

    return {
      text: trimmedText.length > 0 ? trimmedText : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      model: model ?? fallbackModel,
      finishReason,
    };
  }

  private resolveTemperature(override: number | undefined): number {
    if (typeof override === "number" && Number.isFinite(override)) {
      return override;
    }
    const env = Number(process.env.LLM_TEMPERATURE);
    return Number.isFinite(env) ? env : 0.7;
  }

  private resolveMaxTokens(override: number | undefined): number | undefined {
    if (typeof override === "number" && Number.isFinite(override) && override > 0) {
      return override;
    }
    const raw = process.env.LLM_MAX_TOKENS;
    if (raw === undefined || raw === "") {
      return undefined;
    }
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  private shouldLogLlmDev(): boolean {
    return process.env.NODE_ENV !== "production";
  }

  private formatMessagesForDevLog(
    messages: LlmChatMessage[],
  ): Array<{ role: string; content: string }> {
    const raw = process.env.LLM_DEV_LOG_TRUNCATE?.trim();
    const limit = raw === undefined || raw === "" ? 4000 : raw === "0" ? 0 : Number(raw);
    const max = Number.isFinite(limit) && limit >= 0 ? limit : 4000;

    return messages.map((m) => {
      const content =
        typeof m.content === "string"
          ? m.content
          : m.tool_calls
            ? `[tool_calls: ${m.tool_calls.map((t) => t.function.name).join(", ")}]`
            : "";
      if (max === 0 || content.length <= max) {
        return { role: m.role, content };
      }
      return {
        role: m.role,
        content: `${content.slice(0, max)}… (truncated, ${content.length} chars total)`,
      };
    });
  }
}
