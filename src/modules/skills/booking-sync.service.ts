import { Injectable } from "@nestjs/common";
import type { Booking } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MestoClientService } from "./mesto-client.service";
import {
  resolveSingleDate,
  ymd,
  parseTimePreference,
  pickSlotStartsAt,
  normalizePhone,
  isAnyMaster,
} from "./datetime.util";

export interface FoundAppointment {
  /** Локальный Booking (если запись делал этот бот) — для обновления статуса. */
  bookingId: string | null;
  mestoAppointmentId: string;
  booking: Booking | null;
}

/**
 * Общие операции синка с Mesto, используемые навыками book_slot / cancel_booking /
 * reschedule_booking: подбор реального слота и поиск активной записи клиента.
 */
@Injectable()
export class BookingSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mesto: MestoClientService,
  ) {}

  /** Подбирает `starts_at` под названные дату/время через Mesto availability. null — нет окна. */
  async findOpenSlot(
    botId: string,
    p: {
      serviceExternalId?: string;
      serviceName?: string;
      master?: string;
      date?: string;
      time?: string;
    },
  ): Promise<string | null> {
    if (!p.date) return null;
    const day = resolveSingleDate(p.date);
    if (!day) return null;
    const dayStr = ymd(day);

    const res = await this.mesto.getAvailability(botId, {
      from: dayStr,
      to: dayStr,
      serviceExternalId: p.serviceExternalId,
      serviceName: p.serviceName,
      masterName: isAnyMaster(p.master) ? undefined : p.master,
    });
    if (res.status !== 200 || !res.body) return null;
    const d = res.body.days?.[0];
    if (!d || d.status !== "open" || d.slots.length === 0) return null;
    return pickSlotStartsAt(d.slots, parseTimePreference(p.time));
  }

  /**
   * Находит активную запись клиента: сначала по локальным Booking этого диалога
   * (или по телефону), затем — fallback в Mesto по телефону.
   */
  async findClientAppointment(
    botId: string,
    conversationId?: string,
    phone?: string,
  ): Promise<FoundAppointment | null> {
    let booking: Booking | null = null;
    if (conversationId) {
      booking = await this.prisma.booking.findFirst({
        where: { botId, conversationId, status: "confirmed", mestoAppointmentId: { not: null } },
        orderBy: { createdAt: "desc" },
      });
    }
    if (!booking && phone) {
      booking = await this.prisma.booking.findFirst({
        where: { botId, phone, status: "confirmed", mestoAppointmentId: { not: null } },
        orderBy: { createdAt: "desc" },
      });
    }
    if (booking?.mestoAppointmentId) {
      return { bookingId: booking.id, mestoAppointmentId: booking.mestoAppointmentId, booking };
    }

    if (phone) {
      const res = await this.mesto.listBookings(botId, {
        phone: normalizePhone(phone),
        status: "scheduled",
      });
      const list =
        res.status === 200 && res.body?.bookings
          ? (res.body.bookings as Array<{ appointment_id?: string }>)
          : [];
      if (list.length > 0 && list[0].appointment_id) {
        return { bookingId: null, mestoAppointmentId: list[0].appointment_id, booking: null };
      }
    }
    return null;
  }
}
