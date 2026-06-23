/**
 * Чистые помощники для каталога услуг (`config/<id>/data/services.json`).
 * Используются и навыком `lookup_service`, и `book_slot` (вычисление суммы) — чтобы
 * логика поиска услуги и резолва цены/длительности по мастеру не дублировалась.
 */

export interface CatalogService {
  id?: string;
  name: string;
  category?: string;
  /** Базовая длительность (мин) — fallback, если по мастеру не задана. */
  duration?: number;
  /** Длительность по мастеру (мин): имя мастера → минуты. */
  durations?: Record<string, number>;
  /** Базовая («от») цена — fallback, если по мастеру цена не задана. */
  price?: number;
  /** Цена по мастеру: имя мастера → цена. */
  prices?: Record<string, number>;
  notes?: string;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/ё/g, "е");
}

/** Сопоставление имени мастера по корню (на случай «Дарье»/«Василисе» вместо им. падежа). */
export function masterMatches(name: string, query: string): boolean {
  const a = normalize(name);
  const b = normalize(query);
  if (!a || !b) {
    return false;
  }
  const stem = b.slice(0, Math.min(4, b.length));
  return a.startsWith(stem) || b.startsWith(a.slice(0, Math.min(4, a.length)));
}

/** Значение по мастеру из карты «имя → число» (цена или длительность); undefined если нет. */
export function valueForMaster(
  map: Record<string, number> | undefined,
  master: string | undefined,
): number | undefined {
  if (!map || !master) {
    return undefined;
  }
  for (const [name, value] of Object.entries(map)) {
    if (masterMatches(name, master)) {
      return value;
    }
  }
  return undefined;
}

/** Цена услуги для мастера; fallback на базовую `price`. undefined если нет вообще. */
export function priceFor(service: CatalogService, master?: string): number | undefined {
  return valueForMaster(service.prices, master) ?? service.price;
}

/** Длительность услуги для мастера; fallback на базовую `duration`. */
export function durationFor(service: CatalogService, master?: string): number | undefined {
  return valueForMaster(service.durations, master) ?? service.duration;
}

function scoreService(s: CatalogService, tokens: string[]): number {
  const name = normalize(s.name);
  const hay = normalize(`${s.name} ${s.category ?? ""}`);
  let n = 0;
  for (const t of tokens) {
    const tok = normalize(t);
    if (hay.includes(tok)) {
      n += 1;
      // Бонус, если название НАЧИНАЕТСЯ с токена: «Коррекция бровей» должна
      // обыграть «Оформление бровей (коррекция + окрашивание)» по запросу «коррекция».
      if (name.startsWith(tok)) {
        n += 0.5;
      }
    }
  }
  return n;
}

/**
 * Поиск услуг по строке запроса; до `limit` совпадений, отсортированы по релевантности.
 * Тай-брейк: при равном score — более короткое (более конкретное) название выше,
 * чтобы единичный токен не «прилипал» к длинным составным услугам.
 */
export function findServices<T extends CatalogService>(
  services: readonly T[],
  query: string,
  limit = 5,
): T[] {
  const tokens = normalize(query)
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) {
    return [];
  }
  return services
    .map((service) => ({ service, score: scoreService(service, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.service.name.length - b.service.name.length)
    .slice(0, limit)
    .map((x) => x.service);
}
