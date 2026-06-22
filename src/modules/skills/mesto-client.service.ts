import { Injectable, Logger } from "@nestjs/common";
import { BotConfigurationService } from "../bot-configuration/bot-configuration.service";

export interface MestoSlot {
  starts_at: string;
  ends_at: string;
  master_id: string | null;
  master_name: string | null;
}

export interface MestoDay {
  date: string;
  status: "open" | "closed";
  closed_reason: string | null;
  slots: MestoSlot[];
}

export interface AvailabilityParams {
  /** YYYY-MM-DD (включительно) в зоне бизнеса. */
  from: string;
  to: string;
  serviceExternalId?: string;
  serviceName?: string;
  masterName?: string;
  masterId?: string;
  granularityMinutes?: number;
}

export interface CreateBookingBody {
  idempotency_key: string;
  service_external_id?: string;
  service_name: string;
  /** RFC 3339 с offset бизнеса (из слота availability). */
  starts_at: string;
  duration_minutes: number;
  amount?: number | null;
  currency?: string | null;
  client: { name: string; phone: string; telegram_id?: string | number };
  master_name?: string | null;
  master_id?: string | null;
  notes?: string | null;
}

export interface PatchBookingBody {
  starts_at?: string;
  duration_minutes?: number;
  service_external_id?: string | null;
  service_name?: string | null;
  master_name?: string | null;
  master_id?: string | null;
  notes?: string | null;
}

/**
 * Ответ HTTP-вызова Mesto. `status === 0` → запрос НЕ ушёл (CRM не настроена /
 * нет ключа) или сеть упала после ретраев — вызывающий трактует как «не подтвердили».
 */
export interface MestoResponse<T = unknown> {
  status: number;
  body: T | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * HTTP-клиент CRM Mesto, per-bot (Bearer-ключ из `crm.apiKeyEnv`, baseUrl из
 * `crm.baseUrl`). Ретраит только сетевые сбои и 5xx; 4xx (валидация/конфликт/
 * блок) возвращает как есть — это бизнес-ответы, их разбирает FSM/навык.
 */
@Injectable()
export class MestoClientService {
  private readonly logger = new Logger(MestoClientService.name);
  private static readonly RETRY_DELAYS_MS = [0, 300, 900];

  constructor(private readonly botConfig: BotConfigurationService) {}

  isConfigured(botId: string): boolean {
    return this.resolve(botId) !== null;
  }

  private resolve(botId: string): { baseUrl: string; key: string } | null {
    const crm = this.botConfig.resolveById(botId).crm;
    if (!crm || crm.provider !== "mesto") return null;
    const key = process.env[crm.apiKeyEnv]?.trim();
    if (!key) {
      this.logger.warn(
        `CRM key env "${crm.apiKeyEnv}" пуст для bot=${botId} — вызовы Mesto отключены.`,
      );
      return null;
    }
    return { baseUrl: crm.baseUrl, key };
  }

  private async request<T>(
    botId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<MestoResponse<T>> {
    const r = this.resolve(botId);
    if (!r) return { status: 0, body: null };

    const url = `${r.baseUrl}${path}`;
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${r.key}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    const delays = MestoClientService.RETRY_DELAYS_MS;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await sleep(delays[attempt]);
      try {
        const res = await fetch(url, init);
        const parsed = (await res.json().catch(() => null)) as T | null;
        if (res.status >= 500 && attempt < delays.length - 1) {
          this.logger.warn(`Mesto ${method} ${path} → ${res.status}, ретрай.`);
          continue;
        }
        return { status: res.status, body: parsed };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Mesto ${method} ${path} сеть упала (попытка ${attempt + 1}): ${msg}`);
        if (attempt === delays.length - 1) return { status: 0, body: null };
      }
    }
    return { status: 0, body: null };
  }

  getAvailability(
    botId: string,
    p: AvailabilityParams,
  ): Promise<MestoResponse<{ days: MestoDay[] }>> {
    const q = new URLSearchParams();
    q.set("from", p.from);
    q.set("to", p.to);
    if (p.serviceExternalId) q.set("service_external_id", p.serviceExternalId);
    if (p.serviceName) q.set("service_name", p.serviceName);
    if (p.masterName) q.set("master_name", p.masterName);
    if (p.masterId) q.set("master_id", p.masterId);
    if (p.granularityMinutes) q.set("granularity_minutes", String(p.granularityMinutes));
    return this.request(botId, "GET", `/api/external/availability?${q.toString()}`);
  }

  createBooking(botId: string, body: CreateBookingBody): Promise<MestoResponse> {
    return this.request(botId, "POST", "/api/external/bookings", body);
  }

  patchBooking(
    botId: string,
    appointmentId: string,
    body: PatchBookingBody,
  ): Promise<MestoResponse> {
    return this.request(botId, "PATCH", `/api/external/bookings/${appointmentId}`, body);
  }

  cancelBooking(
    botId: string,
    appointmentId: string,
    reason?: "client_cancelled" | "rescheduled" | "bot_false_trigger",
  ): Promise<MestoResponse> {
    return this.request(botId, "POST", `/api/external/bookings/${appointmentId}/cancel`, {
      reason: reason ?? "client_cancelled",
    });
  }

  listBookings(
    botId: string,
    params: { telegramId?: string | number; phone?: string; status?: string; from?: string },
  ): Promise<MestoResponse<{ bookings: unknown[] }>> {
    const q = new URLSearchParams();
    if (params.telegramId !== undefined) q.set("telegram_id", String(params.telegramId));
    if (params.phone) q.set("phone", params.phone);
    if (params.status) q.set("status", params.status);
    if (params.from) q.set("from", params.from);
    return this.request(botId, "GET", `/api/external/bookings?${q.toString()}`);
  }

  upsertClient(
    botId: string,
    body: { name: string; phone: string; telegram_id?: string | number; note?: string },
  ): Promise<MestoResponse<{ client_id: string; client_created: boolean }>> {
    return this.request(botId, "POST", "/api/external/clients", body);
  }
}
