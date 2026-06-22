import type { LanguagePack } from "./language-pack.types";
import { ruPack } from "./packs/ru.pack";

/**
 * Реестр языковых паков. Пур-функция (без DI) — её одинаково зовут сервисы ядра
 * и тесты. Резолв: точное совпадение кода → база до дефиса ("ru-RU" → "ru") → дефолт.
 *
 * Дефолт — ru: это сохраняет историческое поведение (раньше все RU-константы были
 * единственными). EN/прочие паки — следующий шаг: достаточно `registerLanguagePack`.
 */
const PACKS = new Map<string, LanguagePack>([[ruPack.code, ruPack]]);

const DEFAULT_PACK = ruPack;

export function getLanguagePack(code: string | null | undefined): LanguagePack {
  if (code) {
    const lower = code.toLowerCase();
    const exact = PACKS.get(lower);
    if (exact) {
      return exact;
    }
    const base = PACKS.get(lower.split("-")[0]);
    if (base) {
      return base;
    }
  }
  return DEFAULT_PACK;
}

/** Регистрирует/перекрывает пак (для будущих языков и плагинов). */
export function registerLanguagePack(pack: LanguagePack): void {
  PACKS.set(pack.code.toLowerCase(), pack);
}

export function availableLanguages(): string[] {
  return [...PACKS.keys()];
}
