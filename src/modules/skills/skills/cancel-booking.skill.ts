import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Skill, SkillContext, SkillResult } from "../skill.contract";
import { MestoClientService } from "../mesto-client.service";
import { BookingSyncService } from "../booking-sync.service";

/**
 * cancel_booking — отмена записи клиента в Mesto. LLM-callable: вызывай, когда
 * клиент явно просит отменить (и ты убедился, что именно отменить, а не перенести).
 */
@Injectable()
export class CancelBookingSkill implements Skill {
  private readonly logger = new Logger(CancelBookingSkill.name);

  readonly name = "cancel_booking";
  readonly description =
    "Отменить запись клиента. Сначала убедись, что клиент действительно хочет отменить (а не перенести).";
  readonly parameters = {
    type: "object",
    properties: {
      phone: {
        type: "string",
        description: "Телефон клиента, если он его назвал — поможет найти запись.",
      },
    },
    required: [],
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly mesto: MestoClientService,
    private readonly sync: BookingSyncService,
  ) {}

  async execute(args: Record<string, unknown>, ctx: SkillContext): Promise<SkillResult> {
    if (!this.mesto.isConfigured(ctx.botId)) {
      return { data: { ok: false, error: "crm_not_configured" } };
    }
    const phone = this.str(args.phone);
    const found = await this.sync.findClientAppointment(ctx.botId, ctx.conversationId, phone);
    if (!found) {
      return {
        data: { ok: false, error: "not_found", note: "Не нашла активную запись — уточните телефон." },
      };
    }

    const res = await this.mesto.cancelBooking(ctx.botId, found.mestoAppointmentId, "client_cancelled");
    if (res.status === 200) {
      if (found.bookingId) {
        await this.prisma.booking.update({
          where: { id: found.bookingId },
          data: { status: "cancelled" },
        });
      }
      this.logger.log(`Cancelled bot=${ctx.botId} appt=${found.mestoAppointmentId}`);
      return { data: { ok: true, cancelled: true } };
    }
    return { data: { ok: false, error: `http_${res.status}` } };
  }

  private str(v: unknown): string | undefined {
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
}
