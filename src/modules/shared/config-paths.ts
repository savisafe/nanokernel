import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Единая точка резолва путей конфигов и данных ботов.
 *
 * Layout (per-business): всё про одного бота лежит в `<root>/businesses/<id>/`:
 *   - `configuration.json` — декларация бота (BotConfig v2);
 *   - `data/<entity>.json` — структурные данные для skills.
 * Это даёт co-location: переезд/клонирование бизнеса = перенос одной папки.
 *
 * Legacy layout поддерживается как fallback (плавный переход):
 *   - `<root>/configurations/<id>.json`
 *   - `<root>/data/<id>/<entity>.json`
 *
 * `CONFIG_ROOT` (env) переопределяет корень (по умолчанию `<cwd>/config`).
 * Менять расположение конфигов при переезде нужно ТОЛЬКО здесь.
 */

const BUSINESSES_DIR = "businesses";
const LEGACY_CONFIG_DIR = "configurations";
const DATA_DIR = "data";
const CONFIG_FILE = "configuration.json";

export function configRoot(): string {
  const override = process.env.CONFIG_ROOT?.trim();
  return override && override.length > 0
    ? path.resolve(override)
    : path.resolve(process.cwd(), "config");
}

/** Путь к файлу конфигурации бота. Новый layout приоритетнее legacy. */
export function resolveBotConfigFile(id: string): string {
  const root = configRoot();
  const perBusiness = path.join(root, BUSINESSES_DIR, id, CONFIG_FILE);
  if (existsSync(perBusiness)) {
    return perBusiness;
  }
  return path.join(root, LEGACY_CONFIG_DIR, `${id}.json`);
}

/** Все известные id ботов из обоих layout-ов (без дублей). */
export function listBotConfigIds(): string[] {
  const root = configRoot();
  const ids = new Set<string>();

  const businessesDir = path.join(root, BUSINESSES_DIR);
  try {
    for (const entry of readdirSync(businessesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(path.join(businessesDir, entry.name, CONFIG_FILE))) {
        ids.add(entry.name);
      }
    }
  } catch {
    // папки businesses может не быть — это ок (только legacy layout).
  }

  const legacyDir = path.join(root, LEGACY_CONFIG_DIR);
  try {
    for (const f of readdirSync(legacyDir)) {
      if (f.endsWith(".json")) {
        ids.add(f.slice(0, -5));
      }
    }
  } catch {
    // legacy папки может не быть — это ок (только новый layout).
  }

  return [...ids];
}

/** Путь к файлу domain data сущности бота. Новый layout приоритетнее legacy. */
export function resolveDomainDataFile(botId: string, entity: string): string {
  const root = configRoot();
  const perBusiness = path.join(root, BUSINESSES_DIR, botId, DATA_DIR, `${entity}.json`);
  if (existsSync(perBusiness)) {
    return perBusiness;
  }
  return path.join(root, DATA_DIR, botId, `${entity}.json`);
}
