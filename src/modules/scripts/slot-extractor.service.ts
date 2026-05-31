import { Injectable, Logger } from "@nestjs/common";
import { LlmService } from "../llm/llm.service";
import type { ScriptSpec } from "../bot-configuration/v2/bot-config-v2.types";

/**
 * Результат извлечения для одного скрипта.
 *  - intentMatch: подходит ли реплика под намерение сценария (из конфига);
 *  - slots: извлечённые/нормализованные значения, ключи = имена слотов скрипта.
 */
export interface ScriptExtraction {
  intentMatch: boolean;
  slots: Record<string, string>;
}

/**
 * Доменно-НЕЙТРАЛЬНЫЙ извлекатель: превращает свободную речь клиента в структуру по
 * описанию из КОНФИГА скрипта (`scriptSpec.extraction`: intent + fields-подсказки, уже
 * проинтерполированные businessInfo на этапе адаптации). Ядро не знает ни про брови, ни
 * про услуги/мастеров — весь домен в конфиге. Заменяет хрупкие regex-триггеры и
 * regex-валидацию слотов.
 *
 * Это НЕ оркестрация (нестабильна на малых моделях), а одна короткая классификация с
 * жёстким JSON-выводом (temp 0.1) — надёжно даже на 4B. Сбой (пусто/невалидный JSON) →
 * null, и FSM падает на прежнее regex-поведение.
 */
@Injectable()
export class SlotExtractorService {
  private readonly logger = new Logger(SlotExtractorService.name);

  constructor(private readonly llm: LlmService) {}

  async extract(scriptSpec: ScriptSpec, message: string): Promise<ScriptExtraction | null> {
    const ex = scriptSpec.extraction;
    if (!ex || !this.llm.isEnabled()) return null;
    const text = message?.trim();
    if (!text) return null;
    const fieldKeys = Object.keys(ex.fields);
    if (fieldKeys.length === 0) return null;

    const fieldLines = fieldKeys.map((k) => `- "${k}": ${ex.fields[k]}`).join("\n");
    const shape = `{"intentMatch": true|false, ${fieldKeys
      .map((k) => `"${k}": string|null`)
      .join(", ")}}`;
    const noMatch = `{"intentMatch": false, ${fieldKeys.map((k) => `"${k}": null`).join(", ")}}`;
    // TODO ru hardcode
    const sys =
      "Ты извлекаешь данные из сообщения клиента для сценария. " +
      `intentMatch=true, если клиент хочет: ${ex.intent}; иначе false.\n` +
      `Извлеки поля (значение или null, если клиент его не назвал). Заполняй КАЖДОЕ поле, упомянутое в сообщении, — одна фраза может содержать несколько полей сразу (напр. «<день> в <время>» → и день, и время):\n${fieldLines}\n` +
      `Ответь СТРОГО JSON одной строкой, без пояснений и текста вокруг:\n${shape}\n` +
      `Если сообщение НЕ относится к сценарию — верни ровно: ${noMatch}\nТолько JSON, ничего больше.`;

    const out = await this.llm.complete(
      [
        { role: "system", content: sys },
        { role: "user", content: text },
      ],
      { temperature: 0.1, maxTokens: 100 },
    );
    if (!out?.text) {
      this.logger.warn(`extract: пустой ответ LLM на "${text.slice(0, 40)}"`);
      return null;
    }
    try {
      const m = out.text.match(/\{[\s\S]*\}/);
      const p = JSON.parse(m ? m[0] : out.text) as Record<string, unknown>;
      const slots: Record<string, string> = {};
      for (const k of fieldKeys) {
        const v = p[k];
        if (typeof v === "string") {
          const t = v.trim();
          if (t && t.toLowerCase() !== "null") slots[k] = t;
        }
      }
      return { intentMatch: p.intentMatch === true, slots };
    } catch {
      this.logger.warn(`extract: JSON не распарсился: "${out.text.slice(0, 80)}"`);
      return null;
    }
  }
}
