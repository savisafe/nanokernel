import { Injectable, Logger } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { resolveDomainDataFile } from "../shared/config-paths";

/**
 * Структурные данные бота (каталоги, прайсы, расписания и т.п.).
 * Хранение (per-bot): `config/<botId>/data/<entity>.json`
 * (legacy-fallback `config/data/<botId>/<entity>.json`), резолв — `config-paths.ts`.
 * Кеш — in-memory на процесс.
 *
 * В отличие от RAG/документов, эти данные читаются точечно skills, без чанкинга
 * и эмбеддингов — экономия токенов и предсказуемость ответов.
 */
@Injectable()
export class DomainDataService {
  private readonly logger = new Logger(DomainDataService.name);
  private readonly cache = new Map<string, unknown>();

  /** Возвращает массив записей сущности; пустой массив если файл отсутствует или невалиден. */
  list<T = Record<string, unknown>>(botId: string, entity: string): T[] {
    const key = `${botId}:${entity}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached as T[];
    }
    const filePath = resolveDomainDataFile(botId, entity);
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this.logger.warn(`Domain data ${filePath} is not an array — treating as empty.`);
        this.cache.set(key, []);
        return [];
      }
      this.cache.set(key, parsed);
      return parsed as T[];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.debug(`Domain data ${filePath} not loaded: ${msg}`);
      this.cache.set(key, []);
      return [];
    }
  }
}
