import { Injectable, Logger } from "@nestjs/common";

export interface LlmChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompleteOptions {
  /** Per-bot override; fallback — env LLM_TEMPERATURE, далее дефолт 0.7. */
  temperature?: number;
  /** Per-bot override; fallback — env LLM_MAX_TOKENS, далее без лимита. */
  maxTokens?: number;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  isEnabled(): boolean {
    const v = process.env.LLM_ENABLED?.toLowerCase();
    return v === "true" || v === "1" || v === "yes";
  }

  async complete(messages: LlmChatMessage[], options?: LlmCompleteOptions): Promise<string | null> {
    if (!this.isEnabled()) {
      return null;
    }

    const baseUrl = process.env.LLM_BASE_URL;
    const model = process.env.LLM_MODEL;
    const apiKey = process.env.LLM_API_KEY;

    const maxTokens = this.resolveMaxTokens(options?.maxTokens);
    const temperature = this.resolveTemperature(options?.temperature);

    const url = `${baseUrl}/chat/completions`;
    try {
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature,
      };
      if (maxTokens !== undefined && maxTokens > 0) {
        body.max_tokens = maxTokens;
      }

      if (this.shouldLogLlmDev()) {
        const payload = this.formatMessagesForDevLog(messages);
        this.logger.debug(
          `LLM → ${url} model=${model} messages=${messages.length} temperature=${body.temperature}` +
            (body.max_tokens != null ? ` max_tokens=${body.max_tokens}` : "") +
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
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (this.shouldLogLlmDev() && text) {
        const preview = text.length > 500 ? `${text.slice(0, 500)}… (${text.length} chars)` : text;
        this.logger.debug(`LLM ← reply preview:\n${preview}`);
      }
      return text && text.length > 0 ? text : null;
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        this.logger.warn(`LLM request aborted (timeout LLM_TIMEOUT_MS=${process.env.LLM_TIMEOUT_MS ?? "unset"})`);
      } else {
        this.logger.warn(`LLM request failed: ${error}`);
      }
      return null;
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

  private formatMessagesForDevLog(messages: LlmChatMessage[]): Array<{ role: string; content: string }> {
    const raw = process.env.LLM_DEV_LOG_TRUNCATE?.trim();
    const limit =
      raw === undefined || raw === "" ? 4000 : raw === "0" ? 0 : Number(raw);
    const max = Number.isFinite(limit) && limit >= 0 ? limit : 4000;

    return messages.map((m) => {
      if (max === 0 || m.content.length <= max) {
        return { role: m.role, content: m.content };
      }
      return {
        role: m.role,
        content: `${m.content.slice(0, max)}… (truncated, ${m.content.length} chars total)`,
      };
    });
  }
}
