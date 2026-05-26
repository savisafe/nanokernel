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
}

export interface LlmCompleteResult {
  text: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  model?: string;
}

export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type LlmToolDispatcher = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

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
      return null;
    }
    return { text: choice.text, usage: choice.usage, model: choice.model };
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
        };
      }
      return null;
    }

    // Лимит итераций исчерпан — принудительно просим ответ без tools.
    const final = await this.chatRequest(messages, options);
    if (!final?.text || final.text.length === 0) {
      return null;
    }
    promptTokens += final.usage?.promptTokens ?? 0;
    completionTokens += final.usage?.completionTokens ?? 0;
    return {
      text: final.text,
      usage: { promptTokens, completionTokens },
      model: final.model ?? lastModel,
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

    if (this.shouldLogLlmDev()) {
      const payload = this.formatMessagesForDevLog(messages);
      this.logger.debug(
        `LLM → ${url} model=${model} messages=${messages.length} temperature=${temperature}` +
          (maxTokens != null ? ` max_tokens=${maxTokens}` : "") +
          (tools && tools.length > 0 ? ` tools=${tools.length}` : "") +
          `\n${JSON.stringify(payload, null, 2)}`,
      );
    }

    const timeoutRaw = process.env.LLM_TIMEOUT_MS?.trim();
    const timeoutMs =
      timeoutRaw !== undefined && timeoutRaw !== "" ? Number(timeoutRaw) : 0;
    const signal =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? AbortSignal.timeout(timeoutMs)
        : undefined;

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

      const data = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: LlmToolCall[];
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
        model: data.model ?? model,
        finishReason: first?.finish_reason,
      };
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
    const limit =
      raw === undefined || raw === "" ? 4000 : raw === "0" ? 0 : Number(raw);
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
