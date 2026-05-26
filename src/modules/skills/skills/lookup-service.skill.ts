import { Injectable } from "@nestjs/common";
import { DomainDataService } from "../domain-data.service";
import { Skill, SkillContext, SkillResult } from "../skill.contract";

interface SalonService {
  id: string;
  name: string;
  duration: number;
  price: number;
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
    "Найти услуги салона по названию или категории. Возвращает до 5 совпадений с ценой и длительностью.";
  readonly parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Название услуги или ключевые слова (например, «маникюр», «педикюр с покрытием», «дизайн»).",
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
        matches: matches.map((s) => ({
          name: s.name,
          price: s.price,
          duration: s.duration,
          ...(s.notes ? { notes: s.notes } : {}),
        })),
      },
    };
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
