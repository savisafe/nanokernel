import { Injectable } from "@nestjs/common";
import { DomainDataService } from "../domain-data.service";
import { Skill, SkillContext, SkillResult } from "../skill.contract";

interface SalonService {
  id: string;
  name: string;
  /** Базовая длительность (мин) — fallback, если по мастеру не задана. */
  duration: number;
  /** Длительность по конкретному мастеру (мин): имя мастера → минуты. */
  durations?: Record<string, number>;
  /** Базовая («от») цена — fallback, если по мастеру цена не задана. */
  price: number;
  /** Цена по конкретному мастеру: имя мастера → цена. */
  prices?: Record<string, number>;
  category?: string;
  notes?: string;
}

/**
 * lookup_service — поиск услуги салона по ключевым словам/категории.
 * Данные: `config/data/<botId>/services.json` (массив SalonService).
 */
@Injectable()
export class LookupServiceSkill implements Skill {
  readonly name = "lookup_service";
  readonly description =
    "Найти услуги салона по названию или категории. Возвращает до 5 совпадений с ценой и длительностью. Если указан мастер — вернёт цену именно у него.";
  readonly parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Название услуги или ключевые слова (например, «коррекция», «окрашивание», «комплекс»).",
      },
      master: {
        type: "string",
        description:
          "Опционально: имя мастера, чтобы вернуть цену именно у него (например, «Дарья», «Василиса»).",
      },
    },
    required: ["query"],
  };

  constructor(private readonly data: DomainDataService) {}

  async execute(args: Record<string, unknown>, ctx: SkillContext): Promise<SkillResult> {
    const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    if (!query) {
      return { data: { error: "query is required" } };
    }
    const master = typeof args.master === "string" ? args.master.trim() : "";
    const services = this.data.list<SalonService>(ctx.botId, "services");
    if (services.length === 0) {
      return { data: { error: "no service catalog configured for this bot" } };
    }
    const tokens = query.split(/\s+/).filter((t) => t.length >= 2);
    const matches = services
      .map((s) => ({
        service: s,
        score: this.score(s, tokens),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((x) => x.service);

    if (matches.length === 0) {
      return { data: { matches: [], note: "no matches" } };
    }
    return {
      data: {
        matches: matches.map((s) => {
          const masterPrice = master ? this.forMaster(s.prices, master) : undefined;
          const masterDuration = master ? this.forMaster(s.durations, master) : undefined;
          return {
            name: s.name,
            // base price/duration — «от» / fallback, когда мастер не задан или у него нет своих.
            price: s.price,
            ...(s.prices ? { pricesByMaster: s.prices } : {}),
            ...(masterPrice !== undefined ? { priceForMaster: masterPrice } : {}),
            duration: s.duration,
            ...(s.durations ? { durationsByMaster: s.durations } : {}),
            ...(masterDuration !== undefined ? { durationForMaster: masterDuration } : {}),
            ...(s.notes ? { notes: s.notes } : {}),
          };
        }),
      },
    };
  }

  /** Достаёт значение по мастеру из карты «имя → число» (цены или длительности). */
  private forMaster(
    map: Record<string, number> | undefined,
    master: string,
  ): number | undefined {
    if (!map) {
      return undefined;
    }
    const want = this.normalizeMaster(master);
    for (const [name, value] of Object.entries(map)) {
      if (this.masterMatches(this.normalizeMaster(name), want)) {
        return value;
      }
    }
    return undefined;
  }

  private normalizeMaster(value: string): string {
    return value.trim().toLowerCase().replace(/ё/g, "е");
  }

  /** Сопоставление по корню имени (на случай «Дарье»/«Василисе» вместо им. падежа). */
  private masterMatches(name: string, query: string): boolean {
    if (!name || !query) {
      return false;
    }
    const stem = query.slice(0, Math.min(4, query.length));
    return name.startsWith(stem) || query.startsWith(name.slice(0, Math.min(4, name.length)));
  }

  private score(s: SalonService, tokens: string[]): number {
    const hay = `${s.name} ${s.category ?? ""}`.toLowerCase().replace(/ё/g, "е");
    let n = 0;
    for (const t of tokens) {
      if (hay.includes(t.replace(/ё/g, "е"))) {
        n += 1;
      }
    }
    return n;
  }
}
