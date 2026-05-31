import { Injectable } from "@nestjs/common";
import { Skill, SkillContext, SkillResult } from "../skill.contract";
import { DomainDataService } from "../domain-data.service";
import { MestoClientService } from "../mesto-client.service";
import { CatalogService, findServices } from "../service-catalog";
import { resolveDateWindow } from "../datetime.util";

/**
 * check_availability — реальные свободные окна из Mesto. Источник правды по
 * расписанию: бот ОБЯЗАН звать этот навык перед тем как назвать клиенту время
 * (guardrails запрещают выдумывать окна). Обёртка над MestoClientService.
 *
 * Дата резолвится best-effort (сегодня/завтра/послезавтра, день недели, ДД.ММ,
 * «ДД <месяц>»); без даты — окно ближайших 7 дней. Время «сейчас» берётся в
 * локали процесса (tz бизнеса живёт в Mesto, оно и отдаёт слоты с offset).
 */
@Injectable()
export class CheckAvailabilitySkill implements Skill {
  readonly name = "check_availability";
  readonly description =
    "Узнать РЕАЛЬНЫЕ свободные окна записи на дату или ближайшие дни. Вызывай ПЕРЕД тем как назвать клиенту время — не придумывай слоты. Можно указать услугу (влияет на длительность) и мастера.";
  readonly parameters = {
    type: "object",
    properties: {
      service: {
        type: "string",
        description: "Название услуги, например «коррекция», «ламинирование».",
      },
      master: {
        type: "string",
        description: "Опционально: имя мастера (Дарья, Василиса, Софья).",
      },
      date: {
        type: "string",
        description:
          "Опционально: день — «сегодня», «завтра», «суббота», «25 марта» или «25.03». Без даты — ближайшие 7 дней.",
      },
    },
    required: [],
  };

  constructor(
    private readonly data: DomainDataService,
    private readonly mesto: MestoClientService,
  ) {}

  async execute(args: Record<string, unknown>, ctx: SkillContext): Promise<SkillResult> {
    if (!this.mesto.isConfigured(ctx.botId)) {
      return {
        data: {
          error: "crm_not_configured",
          note: "Не могу проверить расписание автоматически — уточните, пожалуйста, у мастера.",
        },
      };
    }

    const serviceQuery = this.str(args.service);
    const master = this.str(args.master);
    const dateText = this.str(args.date);

    let serviceExternalId: string | undefined;
    let serviceName: string | undefined;
    if (serviceQuery) {
      const services = this.data.list<CatalogService>(ctx.botId, "services");
      const match = findServices(services, serviceQuery, 1)[0];
      if (match) {
        serviceName = match.name;
        serviceExternalId = match.id;
      } else {
        serviceName = serviceQuery;
      }
    }

    const { from, to } = resolveDateWindow(dateText);

    const res = await this.mesto.getAvailability(ctx.botId, {
      from,
      to,
      serviceExternalId,
      serviceName,
      masterName: master,
    });

    if (res.status === 0) {
      return { data: { error: "crm_unreachable", note: "Расписание сейчас недоступно — уточню у мастера." } };
    }
    if (res.status !== 200 || !res.body) {
      return { data: { error: `http_${res.status}` } };
    }

    const days = (res.body.days ?? []).map((d) => ({
      date: d.date,
      status: d.status,
      ...(d.closed_reason ? { closedReason: d.closed_reason } : {}),
      // HH:MM в зоне бизнеса (slot.starts_at уже с offset бизнеса).
      times:
        d.status === "open"
          ? uniq(d.slots.map((s) => s.starts_at.slice(11, 16))).slice(0, 16)
          : [],
    }));

    return {
      data: {
        service: serviceName ?? null,
        master: master ?? null,
        days,
        note: "Это реальные свободные окна из расписания. Предложи клиенту что-то из них.",
      },
    };
  }

  private str(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const t = value.trim();
    return t.length > 0 ? t : undefined;
  }
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr)];
}
