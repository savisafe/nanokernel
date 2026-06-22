/**
 * Контракт LLM-провайдера — слой транспорта, изолирующий ядро от конкретного
 * вендора/протокола. Текущая реализация — OpenAI-совместимый HTTP endpoint
 * (LM Studio, Ollama, llama.cpp, vLLM, …), но `LlmService` зависит только от
 * этого интерфейса, поэтому добавить нативный провайдер (Anthropic, Bedrock…)
 * = новая реализация + смена DI-привязки, без правок оркестрации/диалога.
 *
 * Wire-типы сообщений/тулов живут здесь (а не в llm.service), чтобы и провайдер,
 * и сервис ссылались на один источник без циклической зависимости.
 */

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

export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Один «ход» ответа провайдера: либо текст, либо tool_calls (либо и то, и то). */
export interface ProviderChatChoice {
  text?: string;
  toolCalls?: LlmToolCall[];
  usage?: ProviderUsage;
  model?: string;
  /** Причина остановки генерации. "length" = обрезано по лимиту токенов (часто мусор). */
  finishReason?: string;
}

export interface ProviderChatRequest {
  messages: LlmChatMessage[];
  /** Если заданы — провайдер включает function-calling. */
  tools?: LlmToolSpec[];
  /** Per-call override; провайдер сам резолвит fallback (env/дефолт). */
  temperature?: number;
  /** Per-call override; провайдер сам резолвит fallback (env/без лимита). */
  maxTokens?: number;
  /** Если задан — провайдер стримит и зовёт callback на каждом приросте текста. */
  onTextDelta?: (accumulatedText: string) => void | Promise<void>;
}

/**
 * Провайдер выполняет ОДИН запрос к модели и возвращает разобранный choice.
 * `null` = транспортная ошибка (HTTP не-2xx / timeout / сеть) — решение о fallback
 * принимает вызывающий (LlmService). Пустой текст без ошибки — это валидный choice
 * с `text: undefined`, не `null`.
 */
export interface LlmProvider {
  readonly id: string;
  chat(request: ProviderChatRequest): Promise<ProviderChatChoice | null>;
}

/** DI-токен провайдера. Привязка задаётся в LlmModule. */
export const LLM_PROVIDER = "LLM_PROVIDER";
