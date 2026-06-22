import { Injectable, Logger } from "@nestjs/common";

export interface LlmToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Permissive shape: assistant с tool_calls идёт без content; tool — с tool_call_id + content. */
export interface LlmChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

export interface LlmCompleteOptions {
  /** Per-bot override; fallback — env LLM_TEMPERATURE, далее дефолт 0.7. */
  temperature?: number;
  /** Per-bot override; fallback — env LLM_MAX_TOKENS, далее без лимита. */
  maxTokens?: number;
  /**
   * Callback для дельт текста при streaming-режиме (только если задан).
   * Получает накопленный текст текущей итерации (для completeWithTools — текст
   * текущего шага tool-loop'а; при переходах между итерациями буфер сбрасывается).
   * Реализация callback'а должна сама throttle'ить дорогие операции (edit message).
   */
  onTextDelta?: (accumulatedText: string) => void | Promise<void>;
}

export interface LlmCompleteResult {
  text: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  model?: string;
  /** Причина остановки генерации. "length" = обрезано по лимиту токенов (часто мусор). */
  finishReason?: string;
}

export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type LlmToolDispatcher = (name: string, args: Record<string, unknown>) => Promise<unknown>;

interface ChatChoice {
  text?: string;
  toolCalls?: LlmToolCall[];
  usage?: LlmCompleteResult["usage"];
  model?: string;
  finishReason?: string;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  isEnabled(): boolean {
    const v = process.env.LLM_ENABLED?.toLowerCase();
    return v === "true" || v === "1" || v === "yes";
  }

  async complete(
    messages: LlmChatMessage[],
    options?: LlmCompleteOptions,
  ): Promise<LlmCompleteResult | null> {
    if (!this.isEnabled()) {
      return null;
    }
    const choice = await this.chatRequest(messages, options);
    if (!choice?.text || choice.text.length === 0) {
      if (choice) {
        this.logger.warn(
          `LLM null reply: пустой ответ модели без tools (finish_reason=${choice.finishReason ?? "?"}). ` +
            `finish_reason=length → модель исчерпала бюджет токенов, не выдав текста.`,
        );
      }
      return null;
    }
    return {
      text: choice.text,
      usage: choice.usage,
      model: choice.model,
      finishReason: choice.finishReason,
    };
  }

  /**
   * LLM-loop с tool calling. Пока LLM возвращает tool_calls — диспатчим и продолжаем.
   * Лимит итераций — защита от бесконечной зацикливаемости. На последнем шаге
   * принудительно делаем запрос без tools, чтобы получить текст.
   */
  async completeWithTools(
    initialMessages: LlmChatMessage[],
    options: LlmCompleteOptions | undefined,
    tools: LlmToolSpec[],
    dispatch: LlmToolDispatcher,
    maxIterations = 4,
  ): Promise<LlmCompleteResult | null> {
    if (!this.isEnabled()) {
      return null;
    }
    if (tools.length === 0) {
      return this.complete(initialMessages, options);
    }

    const messages: LlmChatMessage[] = [...initialMessages];
    let promptTokens = 0;
    let completionTokens = 0;
    let lastModel: string | undefined;

    for (let i = 0; i < maxIterations; i++) {
      const choice = await this.chatRequest(messages, options, tools);
      if (!choice) {
        this.logger.warn(
          `LLM null reply: запрос к LLM не дал ответа в tool-loop ` +
            `(iteration=${i + 1}/${maxIterations}, tools=${tools.length}). ` +
            `Конкретная причина — выше (LLM HTTP … / request failed / aborted) = «причина A».`,
        );
        return null;
      }
      promptTokens += choice.usage?.promptTokens ?? 0;
      completionTokens += choice.usage?.completionTokens ?? 0;
      lastModel = choice.model ?? lastModel;

      if (choice.toolCalls && choice.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: choice.text ?? null,
          tool_calls: choice.toolCalls,
        });
        for (const call of choice.toolCalls) {
          const args = this.parseToolArguments(call.function.arguments);
          let result: unknown;
          try {
            result = await dispatch(call.function.name, args);
          } catch (e) {
            result = { error: e instanceof Error ? e.message : String(e) };
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result ?? null),
          });
        }
        continue;
      }

      if (choice.text && choice.text.length > 0) {
        return {
          text: choice.text,
          usage: { promptTokens, completionTokens },
          model: lastModel,
          finishReason: choice.finishReason,
        };
      }
      this.logger.warn(
        `LLM пусто на tool-ходу (finish_reason=${choice.finishReason ?? "?"}, ` +
          `iteration=${i + 1}/${maxIterations}, tools=${tools.length}) — модель не справилась с ` +
          `function-calling. Повторяю запрос БЕЗ tools (force-retry), чтобы всё равно дать клиенту ответ.`,
      );
      break;
    }

    // Сюда попадаем, исчерпав итерации ИЛИ после пустого tool-ответа (break выше).
    // Принудительно просим ответ БЕЗ tools: обычная генерация у маленькой модели
    // надёжна (в отличие от function-calling), поэтому клиент получит текст, а не «техсбой».
    const final = await this.chatRequest(messages, options);
    if (!final?.text || final.text.length === 0) {
      if (final) {
        this.logger.warn(
          `LLM null reply: пустой ответ даже на форс-запросе БЕЗ tools ` +
            `(finish_reason=${final.finishReason ?? "?"}) — тогда уже фолбэк.`,
        );
      }
      return null;
    }
    promptTokens += final.usage?.promptTokens ?? 0;
    completionTokens += final.usage?.completionTokens ?? 0;
    return {
      text: final.text,
      usage: { promptTokens, completionTokens },
      model: final.model ?? lastModel,
      finishReason: final.finishReason,
    };
  }

  private async chatRequest(
    messages: LlmChatMessage[],
    options: LlmCompleteOptions | undefined,
    tools?: LlmToolSpec[],
  ): Promise<ChatChoice | null> {
    const baseUrl = process.env.LLM_BASE_URL;
    const model = process.env.LLM_MODEL;
    const apiKey = process.env.LLM_API_KEY;

    const maxTokens = this.resolveMaxTokens(options?.maxTokens);
    const temperature = this.resolveTemperature(options?.temperature);
    const useStream = typeof options?.onTextDelta === "function";

    const url = `${baseUrl}/chat/completions`;
    const body: Record<string, unknown> = {
      model,
      messages,
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
      const payload = this.formatMessagesForDevLog(messages);
      this.logger.debug(
        `LLM → ${url} model=${model} messages=${messages.length} temperature=${temperature}` +
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
        return this.parseStreamingResponse(response, model, options?.onTextDelta);
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
  ): Promise<ChatChoice | null> {
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
  ): Promise<ChatChoice | null> {
    if (!response.body) {
      this.logger.warn("LLM stream response has no body");
      return null;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const toolCallsByIndex = new Map<number, LlmToolCall>();
    let usage: ChatChoice["usage"];
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

  private parseToolArguments(raw: string | undefined): Record<string, unknown> {
    if (!raw) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
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
