import { Injectable } from "@nestjs/common";
import { DomainDataService } from "../domain-data.service";
import { Skill, SkillContext, SkillResult } from "../skill.contract";
import { CatalogService, findServices, valueForMaster } from "../service-catalog";

/**
 * lookup_service — поиск услуги салона по ключевым словам/категории.
 * Данные: `config/<id>/data/services.json` (массив CatalogService).
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
    const services = this.data.list<CatalogService>(ctx.botId, "services");
    if (services.length === 0) {
      return { data: { error: "no service catalog configured for this bot" } };
    }
    const matches = findServices(services, query, 5);
    if (matches.length === 0) {
      return { data: { matches: [], note: "no matches" } };
    }
    return {
      data: {
        matches: matches.map((s) => {
          const masterPrice = master ? valueForMaster(s.prices, master) : undefined;
          const masterDuration = master ? valueForMaster(s.durations, master) : undefined;
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
}
