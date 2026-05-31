/**
 * Разбор «человеческих» дат/времени из FSM-слотов и подбор реального слота из
 * ответа Mesto. Время «сейчас» берётся в локали процесса (tz бизнеса живёт в
 * Mesto — оно отдаёт слоты с offset, мы матчим по локальному HH:MM слота).
 */

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const addDays = (d: Date, n: number): Date => {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
};

const MONTHS: Record<string, number> = {
  январ: 1, феврал: 2, март: 3, апрел: 4, ма: 5, июн: 6,
  июл: 7, август: 8, сентябр: 9, октябр: 10, ноябр: 11, декабр: 12,
};
// 0=воскресенье … 6=суббота (как Date.getDay()).
const WEEKDAYS: Record<string, number> = {
  воскресень: 0, понедельник: 1, вторник: 2, сред: 3, четверг: 4, пятниц: 5, суббот: 6,
};

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").trim();
const fullYear = (y: number) => (y < 100 ? 2000 + y : y);

/** Резолвит «человеческую» дату в конкретный день. null — если не распознали. */
export function resolveSingleDate(raw: string, today: Date = new Date()): Date | null {
  const lower = norm(raw);
  if (lower === "сегодня") return today;
  if (lower === "завтра") return addDays(today, 1);
  if (lower === "послезавтра") return addDays(today, 2);

  for (const [stem, wd] of Object.entries(WEEKDAYS)) {
    if (lower.startsWith(stem)) {
      const diff = (wd - today.getDay() + 7) % 7;
      return addDays(today, diff); // ближайший такой день недели (включая сегодня)
    }
  }

  const numeric = lower.match(/^(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?$/);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const year = numeric[3] ? fullYear(Number(numeric[3])) : today.getFullYear();
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) return new Date(year, month - 1, day);
  }

  const worded = lower.match(/(\d{1,2})\s+([а-я]+)/);
  if (worded) {
    const day = Number(worded[1]);
    const key = Object.keys(MONTHS).find((k) => worded[2].startsWith(k));
    if (key && day >= 1 && day <= 31) return new Date(today.getFullYear(), MONTHS[key] - 1, day);
  }
  return null;
}

/** Окно дат: одиночный день (если распознали) или ближайшие 7 дней. */
export function resolveDateWindow(
  dateText?: string,
  today: Date = new Date(),
): { from: string; to: string } {
  const single = dateText ? resolveSingleDate(dateText, today) : null;
  if (single) return { from: ymd(single), to: ymd(single) };
  return { from: ymd(today), to: ymd(addDays(today, 6)) };
}

export interface TimePref {
  /** Точное время (минут от полуночи) — клиент назвал «15:00»/«3 дня». */
  exactMinute?: number;
  /** Не раньше (минут от полуночи) — расплывчато «после обеда»/«вечером». */
  minFromMinute?: number;
}

const hhmmToMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};

/** Разбирает «время» из FSM-слота в предпочтение для выбора слота. */
export function parseTimePreference(raw?: string): TimePref {
  if (!raw) return {};
  const lower = norm(raw);
  if (/после\s+обеда|в\s*обед|днем|днём/.test(lower)) return { minFromMinute: 13 * 60 };
  if (/вечер/.test(lower)) return { minFromMinute: 17 * 60 };
  if (/утр/.test(lower)) return { minFromMinute: 0 };

  const m = lower.match(/(\d{1,2})(?:[:.\s-]([0-5]\d))?/);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (/дня|вечера/.test(lower) && h < 12) h += 12;
    if (h >= 0 && h <= 23) return { exactMinute: h * 60 + min };
  }
  return {};
}

/**
 * Выбирает `starts_at` из открытых слотов под предпочтение клиента.
 * Точное время — только если оно реально открыто (не сдвигаем молча).
 * Расплывчатое — первый открытый слот не раньше порога. Без предпочтения — самый ранний.
 */
export function pickSlotStartsAt(
  slots: { starts_at: string }[],
  pref: TimePref,
): string | null {
  const withMin = slots
    .map((s) => ({ startsAt: s.starts_at, min: hhmmToMin(s.starts_at.slice(11, 16)) }))
    .sort((a, b) => a.min - b.min);
  if (withMin.length === 0) return null;

  if (pref.exactMinute != null) {
    const exact = withMin.find((x) => x.min === pref.exactMinute);
    return exact ? exact.startsAt : null;
  }
  const from = pref.minFromMinute ?? 0;
  const cand = withMin.find((x) => x.min >= from);
  return cand ? cand.startsAt : null;
}

/** Нормализация телефона в E.164 (KZ/RU-ориентир). */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("7")) return `+${digits}`;
  if (digits.length === 10) return `+7${digits}`;
  return `+${digits}`;
}

/** «любой / без разницы / на ваш выбор» — мастер не важен. */
export function isAnyMaster(raw?: string): boolean {
  if (!raw) return true;
  return /^(люб|без\s+разниц|без\s+предпочтени|на\s+ваш\s+выбор)/.test(norm(raw));
}
