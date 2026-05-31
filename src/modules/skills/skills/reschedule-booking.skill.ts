import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Skill, SkillContext, SkillResult } from "../skill.contract";
import { DomainDataService } from "../domain-data.service";
import { MestoClientService } from "../mesto-client.service";
import { BookingSyncService } from "../booking-sync.service";
import { CatalogService, findServices } from "../service-catalog";

/**
 * reschedule_booking — перенос записи клиента на другую дату/время. Находит
 * активную запись, резолвит новый слот через availability и PATCH'ит в Mesto.
 * Услуга/мастер берутся из исходной записи (локальный Booking).
 */
@Injectable()
export class RescheduleBookingSkill implements Skill {
  private readonly logger = new Logger(RescheduleBookingSkill.name);

  readonly name = "reschedule_booking";
  readonly description = "Перенести запись клиента на другую дату/время.";
  readonly parameters = {
    type: "object",
    properties: {
      date: { type: "string", description: "Новый день: «завтра», «суббота», «25.03»." },
      time: { type: "string", description: "Новое время: «15:00», «после обеда»." },
      phone: { type: "string", description: "Телефон клиента, если назвал." },
    },
    required: ["date"],
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly data: DomainDataService,
    private readonly mesto: MestoClientService,
    private readonly sync: BookingSyncService,
  ) {}

  async execute(args: Record<string, unknown>, ctx: SkillContext): Promise<SkillResult> {
    if (!this.mesto.isConfigured(ctx.botId)) {
      return { data: { ok: false, error: "crm_not_configured" } };
    }
    const date = this.str(args.date);
    const time = this.str(args.time);
    const phone = this.str(args.phone);
    if (!date) return { data: { ok: false, error: "date_required" } };

    const found = await this.sync.findClientAppointment(ctx.botId, ctx.conversationId, phone);
    if (!found) {
      return {
        data: { ok: false, error: "not_found", note: "Не нашла активную запись — уточните телефон." },
      };
    }

    const svcName = found.booking?.service ?? undefined;
    const master = found.booking?.master ?? undefined;
    const cat = svcName
      ? findServices(this.data.list<CatalogService>(ctx.botId, "services"), svcName, 1)[0]
      : undefined;

    const startsAt = await this.sync.findOpenSlot(ctx.botId, {
      serviceExternalId: cat?.id,
      serviceName: cat?.name ?? svcName,
      master,
      date,
      time,
    });
    if (!startsAt) return { data: { ok: false, error: "time_unavailable" } };

    const res = await this.mesto.patchBooking(ctx.botId, found.mestoAppointmentId, { starts_at: startsAt });
    if (res.status === 200) {
      if (found.bookingId) {
        await this.prisma.booking.update({
          where: { id: found.bookingId },
          data: { date, ...(time ? { time } : {}) },
        });
      }
      this.logger.log(`Rescheduled bot=${ctx.botId} appt=${found.mestoAppointmentId} → ${startsAt}`);
      return { data: { ok: true, rescheduled: true } };
    }
    if (res.status === 422 || res.status === 409) {
      const code = (res.body as { code?: string })?.code;
      return { data: { ok: false, error: code ?? `http_${res.status}` } };
    }
    return { data: { ok: false, error: `http_${res.status}` } };
  }

  private str(v: unknown): string | undefined {
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
}
