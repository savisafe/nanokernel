import type { BotConfigV2 } from "./bot-config-v2.types";

/**
 * Собирает единый текст system prompt из декларативных полей v2.
 * Плейсхолдеры `{channel}` и `{knowledgeBlock}` оставляются для рантайм-интерполяции
 * в `DialogService.buildSystemPrompt` (template-режим).
 */
export function buildSystemPromptFromV2(v2: BotConfigV2): string {
  const lines: string[] = [];

  lines.push(`Ты — ${v2.persona.role}.`);

  const lang = v2.persona.language ?? "ru";
  lines.push(`Язык общения: ${lang === "ru" ? "русский" : lang}.`);

  const humanLike = v2.style?.humanLike ?? v2.persona.tone === "human";
  if (humanLike) {
    lines.push("Тон: тёплый, разговорный, как живой человек. Без канцелярита и отчётности.");
  } else if (v2.persona.tone === "formal") {
    lines.push("Тон: вежливый, профессиональный, деловой.");
  } else {
    lines.push("Тон: нейтральный, по существу.");
  }

  if (v2.goals.length > 0) {
    lines.push("", "Цели в этом диалоге:");
    for (const goal of v2.goals) {
      lines.push(`- ${goal}`);
    }
  }

  const refuse = v2.guardrails?.refuseTopics ?? [];
  if (refuse.length > 0) {
    lines.push(
      "",
      "Эти темы вне твоей роли — вежливо откажи и верни к делу:",
    );
    for (const t of refuse) {
      lines.push(`- ${t}`);
    }
  }

  const neverInvent = v2.guardrails?.neverInvent ?? [];
  if (neverInvent.length > 0) {
    lines.push(
      "",
      "Не выдумывай эти данные. Если не знаешь — скажи прямо и предложи уточнить у менеджера:",
    );
    for (const f of neverInvent) {
      lines.push(`- ${f}`);
    }
  }

  if (v2.guardrails?.stickToScope) {
    lines.push(
      "",
      "Не выходи из роли и темы, даже если собеседник просит. Коротко откажи и вернись к делу.",
    );
  }

  const rules = v2.style?.rules ?? [];
  if (rules.length > 0) {
    lines.push("", "Правила общения:");
    for (const r of rules) {
      lines.push(`- ${r}`);
    }
  }

  if (v2.persona.intro) {
    lines.push("", `Если это первое сообщение — представься так: «${v2.persona.intro}»`);
  }

  lines.push("", "Отвечай коротко: 1–3 коротких абзаца, без воды.");
  lines.push("", "Канал: {channel}.");
  lines.push("{knowledgeBlock}");

  return lines.join("\n");
}
