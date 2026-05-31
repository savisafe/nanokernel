import { Injectable, Logger } from "@nestjs/common";
import { BotConfigurationService } from "../bot-configuration/bot-configuration.service";

export interface BookingNotice {
  service?: string;
  master?: string;
  /** Дата как её назвал клиент (свободный текст); нормализуется к ДД.ММ.ГГГГ при возможности. */
  date?: string;
  time?: string;
  name?: string;
  phone?: string;
  /** Сумма (целое, тенге); undefined — «уточняется». */
  amount?: number;
}

/**
 * Шлёт служебное уведомление о новой записи в Telegram-чат бизнеса
 * (`notifications.telegramChatId`). Fail-open: ошибки/отсутствие конфига не ломают
 * основной поток — клиент уже получил подтверждение.
 *
 * Этап 1 TODO §11a. Этап 2 (своя CRM) повесится на тот же вызов.
 */
@Injectable()
export class BookingNotifierService {
  private readonly logger = new Logger(BookingNotifierService.name);

  private static readonly MONTHS: Record<string, number> = {
    январ: 1, феврал: 2, март: 3, апрел: 4, ма: 5, июн: 6,
    июл: 7, август: 8, сентябр: 9, октябр: 10, ноябр: 11, декабр: 12,
  };

  constructor(private readonly botConfig: BotConfigurationService) {}

  async notifyNewBooking(botId: string, notice: BookingNotice): Promise<void> {
    try {
      const bot = this.botConfig.resolveById(botId);
      const chatId = bot.notifications?.telegramChatId;
      if (!chatId) {
        this.logger.debug(`No notifications.telegramChatId for bot=${botId} — skip booking notice.`);
        return;
      }
      const tokenEnv = bot.channel?.telegram?.tokenEnv;
      const token = (tokenEnv && process.env[tokenEnv]?.trim()) || process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        this.logger.warn(`No Telegram token for bot=${botId} — cannot send booking notice.`);
        return;
      }

      const text = this.format(notice);
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) {
        this.logger.warn(`Booking notice send failed bot=${botId}: ${res.status} ${await res.text()}`);
      }
    } catch (e) {
      this.logger.warn(
        `Booking notice error bot=${botId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private format(n: BookingNotice): string {
    const lines = ["Новая запись:"];
    lines.push(this.formatDate(n.date));
    if (n.service) lines.push(n.service);
    lines.push(n.master ? n.master : "Мастер не указан");
    lines.push(n.amount !== undefined ? `${n.amount.toLocaleString("ru-RU")} ₸` : "Сумма уточняется");
    // Доп. контекст (время/имя/телефон) — после основного блока.
    const extra: string[] = [];
    if (n.time) extra.push(`Время: ${n.time}`);
    if (n.name) extra.push(`Клиент: ${n.name}`);
    if (n.phone) extra.push(`Телефон: ${n.phone}`);
    return extra.length > 0 ? `${lines.join("\n")}\n\n${extra.join("\n")}` : lines.join("\n");
  }

  /**
   * Best-effort нормализация даты к ДД.ММ.ГГГГ. Понимает «сегодня/завтра/послезавтра»,
   * «ДД.ММ[.ГГГГ]» и «ДД <месяц словом>». Иначе возвращает исходный текст как есть.
   * Полноценный парсер дат (дни недели «суббота» и т.п.) — отдельная задача.
   */
  private formatDate(raw: string | undefined): string {
    const text = (raw ?? "").trim();
    if (!text) {
      return "Дата не указана";
    }
    const lower = text.toLowerCase().replace(/ё/g, "е");
    const today = new Date();

    if (lower === "сегодня") return this.dmy(today);
    if (lower === "завтра") return this.dmy(this.addDays(today, 1));
    if (lower === "послезавтра") return this.dmy(this.addDays(today, 2));

    const numeric = lower.match(/^(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?$/);
    if (numeric) {
      const day = Number(numeric[1]);
      const month = Number(numeric[2]);
      const year = numeric[3] ? this.fullYear(Number(numeric[3])) : today.getFullYear();
      if (this.validDmy(day, month)) {
        return this.dmyParts(day, month, year);
      }
    }

    const worded = lower.match(/(\d{1,2})\s+([а-я]+)/);
    if (worded) {
      const day = Number(worded[1]);
      const monthWord = worded[2];
      const monthKey = Object.keys(BookingNotifierService.MONTHS).find((k) => monthWord.startsWith(k));
      if (monthKey && day >= 1 && day <= 31) {
        const month = BookingNotifierService.MONTHS[monthKey];
        return this.dmyParts(day, month, today.getFullYear());
      }
    }

    return text;
  }

  private addDays(d: Date, days: number): Date {
    const r = new Date(d);
    r.setDate(r.getDate() + days);
    return r;
  }

  private fullYear(y: number): number {
    return y < 100 ? 2000 + y : y;
  }

  private validDmy(day: number, month: number): boolean {
    return day >= 1 && day <= 31 && month >= 1 && month <= 12;
  }

  private dmy(d: Date): string {
    return this.dmyParts(d.getDate(), d.getMonth() + 1, d.getFullYear());
  }

  private dmyParts(day: number, month: number, year: number): string {
    const dd = String(day).padStart(2, "0");
    const mm = String(month).padStart(2, "0");
    return `${dd}.${mm}.${year}`;
  }
}
