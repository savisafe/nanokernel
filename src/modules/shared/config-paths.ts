import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Единая точка резолва путей конфигов и данных ботов.
 *
 * Layout (per-bot): всё про одного бота лежит в `<root>/<id>/`:
 *   - `configuration.json` — декларация бота (BotConfig v2);
 *   - `data/<entity>.json` — структурные данные для skills.
 * Это даёт co-location: переезд/клонирование бота = перенос одной папки.
 *
 * Legacy layout поддерживается как fallback (плавный переход):
 *   - `<root>/configurations/<id>.json`
 *   - `<root>/data/<id>/<entity>.json`
 *
 * `CONFIG_ROOT` (env) переопределяет корень (по умолчанию `<cwd>/config`).
 * Менять расположение конфигов при переезде нужно ТОЛЬКО здесь.
 */

const LEGACY_CONFIG_DIR = "configurations";
const DATA_DIR = "data";
const CONFIG_FILE = "configuration.json";

// Зарезервированные имена папок под корнем config/ — не считаются ботами
// (это контейнеры legacy-layout, а не директории конкретного бота).
const RESERVED_DIRS = new Set([LEGACY_CONFIG_DIR, DATA_DIR]);

export function configRoot(): string {
  const override = process.env.CONFIG_ROOT?.trim();
  return override && override.length > 0
    ? path.resolve(override)
    : path.resolve(process.cwd(), "config");
}

/** Путь к файлу конфигурации бота. Новый layout приоритетнее legacy. */
export function resolveBotConfigFile(id: string): string {
  const root = configRoot();
  const perBot = path.join(root, id, CONFIG_FILE);
  if (existsSync(perBot)) {
    return perBot;
  }
  return path.join(root, LEGACY_CONFIG_DIR, `${id}.json`);
}

/** Все известные id ботов из обоих layout-ов (без дублей). */
export function listBotConfigIds(): string[] {
  const root = configRoot();
  const ids = new Set<string>();

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        !RESERVED_DIRS.has(entry.name) &&
        existsSync(path.join(root, entry.name, CONFIG_FILE))
      ) {
        ids.add(entry.name);
      }
    }
  } catch {
    // папки config может не быть — это ок (только legacy/override).
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
  const perBot = path.join(root, botId, DATA_DIR, `${entity}.json`);
  if (existsSync(perBot)) {
    return perBot;
  }
  return path.join(root, DATA_DIR, botId, `${entity}.json`);
}
