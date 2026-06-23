import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  LLM_PROVIDER,
  LlmChatMessage,
  LlmProvider,
  LlmToolSpec,
  ProviderChatChoice,
} from "./llm-provider.contract";

// Re-export wire-типов: исторически они жили здесь, и пол-кодовой базы импортирует
// { LlmChatMessage, LlmToolSpec, … } из "../llm/llm.service". Источник истины теперь
// в llm-provider.contract, но публичный путь сохранён, чтобы не трогать импорты.
export type { LlmChatMessage, LlmToolCall, LlmToolSpec } from "./llm-provider.contract";

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

export type LlmToolDispatcher = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Оркестрация LLM поверх транспортного провайдера (`LlmProvider`). Здесь живёт всё,
 * что НЕ зависит от вендора: enabled-флаг, tool-loop, force-retry без tools и
 * «пустой ответ → null» — паттерны, выстраданные на маленьких моделях. Сам HTTP/SSE
 * и формат запроса — в провайдере.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(@Inject(LLM_PROVIDER) private readonly provider: LlmProvider) {}

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
    const choice = await this.requestChoice(messages, options);
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
      const choice = await this.requestChoice(messages, options, tools);
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
    const final = await this.requestChoice(messages, options);
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

  /** Делегирует один запрос провайдеру, прокидывая per-call override'ы и streaming-callback. */
  private requestChoice(
    messages: LlmChatMessage[],
    options: LlmCompleteOptions | undefined,
    tools?: LlmToolSpec[],
  ): Promise<ProviderChatChoice | null> {
    return this.provider.chat({
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options?.onTextDelta ? { onTextDelta: options.onTextDelta } : {}),
    });
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
}
