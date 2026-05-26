import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Skill, SkillContext, SkillResult } from "../skill.contract";

/**
 * book_slot — создаёт запись клиента в таблице Booking.
 * Вызывается FSM-скриптом booking при подтверждении.
 * LLM напрямую этот skill вызывать не должен — он завязан на собранные FSM-слоты.
 */
@Injectable()
export class BookSlotSkill implements Skill {
  private readonly logger = new Logger(BookSlotSkill.name);

  readonly name = "book_slot";
  readonly description = "Создать запись клиента после подтверждения. Используется FSM-скриптом, не LLM.";
  readonly parameters = {
    type: "object",
    properties: {
      service: { type: "string" },
      date: { type: "string" },
      time: { type: "string" },
      name: { type: "string" },
      phone: { type: "string" },
    },
  };

  constructor(private readonly prisma: PrismaService) {}

  async execute(args: Record<string, unknown>, ctx: SkillContext): Promise<SkillResult> {
    const service = this.str(args.service);
    const date = this.str(args.date);
    const time = this.str(args.time);
    const name = this.str(args.name);
    const phone = this.str(args.phone);

    try {
      const booking = await this.prisma.booking.create({
        data: {
          botId: ctx.botId,
          conversationId: ctx.conversationId,
          service,
          date,
          time,
          name,
          phone,
          status: "confirmed",
        },
      });
      this.logger.log(
        `Booking created bot=${ctx.botId} id=${booking.id} service="${service}" date="${date}" time="${time}" phone="${phone}"`,
      );
      return {
        data: {
          ok: true,
          bookingId: booking.id,
          service,
          date,
          time,
          name,
          phone,
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Booking creation failed bot=${ctx.botId}: ${msg}`);
      return { data: { ok: false, error: msg } };
    }
  }

  private str(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}
