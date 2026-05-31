import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Skill, SkillContext, SkillResult } from "../skill.contract";
import { DomainDataService } from "../domain-data.service";
import { BookingNotifierService } from "../booking-notifier.service";
import { MestoClientService } from "../mesto-client.service";
import { CatalogService, findServices, priceFor, durationFor } from "../service-catalog";
import { BookingSyncService } from "../booking-sync.service";
import { normalizePhone, isAnyMaster } from "../datetime.util";

/**
 * book_slot — финализация записи (вызывается FSM-скриптом на подтверждении).
 *
 * 1. Пишет локальный `Booking` (аудит; его id → idempotency_key).
 * 2. Если CRM Mesto настроена — резолвит названные клиентом дату/время в реальный
 *    свободный слот (`getAvailability`) и делает синхронный `POST /bookings`:
 *      201/200 → ok (пишем mestoAppointmentId, syncStatus=synced);
 *      422/409 (закрыто/занято) → ok:false → FSM покажет errorReply;
 *      5xx/сеть → fail-open: запись осталась локально, алерт в служебный чат.
 * 3. Если CRM не настроена — прежнее поведение (локальный Booking + уведомление).
 *
 * LLM напрямую этот skill не зовёт — он завязан на собранные FSM-слоты.
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
      master: { type: "string" },
      date: { type: "string" },
      time: { type: "string" },
      name: { type: "string" },
      phone: { type: "string" },
    },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly data: DomainDataService,
    private readonly notifier: BookingNotifierService,
    private readonly mesto: MestoClientService,
    private readonly sync: BookingSyncService,
  ) {}

  async execute(args: Record<string, unknown>, ctx: SkillContext): Promise<SkillResult> {
    const service = this.str(args.service);
    const master = this.str(args.master);
    const date = this.str(args.date);
    const time = this.str(args.time);
    const name = this.str(args.name);
    const phone = this.str(args.phone);

    const cat = this.catalog(ctx.botId, service);
    const amount = cat ? priceFor(cat, master) : undefined;
    const durationMinutes = (cat ? durationFor(cat, master) : undefined) ?? 30;
    const serviceName = cat?.name ?? service;
    const serviceExternalId = cat?.id;

    let booking;
    try {
      booking = await this.prisma.booking.create({
        data: { botId: ctx.botId, conversationId: ctx.conversationId, service, master, date, time, name, phone, amount, status: "confirmed" },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Booking creation failed bot=${ctx.botId}: ${msg}`);
      return { data: { ok: false, error: msg } };
    }

    const notice = { service: serviceName, master, date, time, name, phone, amount };

    // CRM не настроена — прежнее поведение (локальная запись + уведомление).
    if (!this.mesto.isConfigured(ctx.botId)) {
      await this.notifier.notifyNewBooking(ctx.botId, notice);
      return { data: this.okData(booking.id, { service: serviceName, master, date, time, name, phone, amount }) };
    }

    // Резолвим реальный слот.
    const startsAt = await this.sync.findOpenSlot(ctx.botId, {
      serviceExternalId,
      serviceName,
      master,
      date,
      time,
    });
    if (!startsAt) {
      await this.markSync(booking.id, "failed");
      this.logger.log(`No Mesto slot for bot=${ctx.botId} date="${date}" time="${time}" — reject.`);
      return { data: { ok: false, error: "time_unavailable" } };
    }

    const res = await this.mesto.createBooking(ctx.botId, {
      idempotency_key: `${ctx.botId}:${booking.id}`,
      ...(serviceExternalId ? { service_external_id: serviceExternalId } : {}),
      service_name: serviceName ?? "",
      starts_at: startsAt,
      duration_minutes: durationMinutes,
      amount: amount ?? null,
      client: { name: name ?? "", phone: phone ? normalizePhone(phone) : "" },
      master_name: isAnyMaster(master) ? null : master,
    });

    const body = (res.body ?? {}) as { appointment_id?: string; client_id?: string; code?: string };

    if (res.status === 201 || res.status === 200) {
      await this.prisma.booking.update({
        where: { id: booking.id },
        data: {
          mestoAppointmentId: body.appointment_id ?? null,
          mestoClientId: body.client_id ?? null,
          syncStatus: "synced",
          syncedAt: new Date(),
        },
      });
      await this.notifier.notifyNewBooking(ctx.botId, notice);
      this.logger.log(`Booking synced bot=${ctx.botId} id=${booking.id} → appt=${body.appointment_id}`);
      return { data: this.okData(booking.id, { service: serviceName, master, date, time, name, phone, amount, appointmentId: body.appointment_id }) };
    }

    // Закрытая дата / вне часов / занято → клиенту скажем «недоступно» (errorReply).
    if (res.status === 422 || res.status === 409) {
      await this.markSync(booking.id, "failed");
      this.logger.log(`Mesto rejected booking bot=${ctx.botId} id=${booking.id}: ${res.status} ${body.code ?? ""}`);
      return { data: { ok: false, error: body.code ?? `http_${res.status}` } };
    }

    // 5xx / сеть: не теряем запись — оставляем локально и алертим студию.
    await this.markSync(booking.id, "failed");
    await this.notifier.notifyNewBooking(ctx.botId, notice);
    this.logger.warn(`Mesto unreachable bot=${ctx.botId} id=${booking.id} (status=${res.status}) — fail-open + alert.`);
    return { data: this.okData(booking.id, { service: serviceName, master, date, time, name, phone, amount, degraded: true }) };
  }

  private catalog(botId: string, service: string | undefined): CatalogService | undefined {
    if (!service) return undefined;
    const services = this.data.list<CatalogService>(botId, "services");
    if (services.length === 0) return undefined;
    return findServices(services, service, 1)[0];
  }

  private async markSync(bookingId: string, syncStatus: string): Promise<void> {
    await this.prisma.booking.update({ where: { id: bookingId }, data: { syncStatus } });
  }

  private okData(
    bookingId: string,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return { ok: true, bookingId, ...extra };
  }

  private str(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const t = value.trim();
    return t.length > 0 ? t : undefined;
  }
}
