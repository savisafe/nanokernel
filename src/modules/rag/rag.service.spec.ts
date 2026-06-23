import { describe, it, expect } from "vitest";
import { RagService } from "./rag.service";

/**
 * Тесты ГИБРИДНОГО retrieval: вектор + BM25, слитые через RRF. Модель эмбеддингов и нативный
 * sqlite-vec не грузим — embed() и db подменяются фейками, ранжирование векторного сигнала
 * задаётся тестом напрямую. Проверяем: лексический «спасает» то, что вектор упустил;
 * совпадение в обоих сигналах поднимает чанк выше; пустой результат остаётся пустым.
 */

/**
 * Собирает RagService с готовым лексическим индексом по переданным текстам и фейковым
 * векторным сигналом. `vectorOrder` — id чанков (1-based) в порядке близости по вектору.
 */
function ragWith(
  texts: string[],
  vectorOrder: number[],
  fusionOverride?: Record<string, number>,
): RagService {
  const svc = new RagService({} as never, {} as never);
  const s = svc as unknown as {
    chunks: Array<{
      id: number;
      text: string;
      vector: number[];
      tf: Map<string, number>;
      len: number;
    }>;
    df: Map<string, number>;
    avgdl: number;
    fusion: Record<string, number>;
    isReady: boolean;
    db: unknown;
    embed: (t: string) => Promise<number[]>;
    tokenize: (t: string) => string[];
  };

  if (fusionOverride) {
    s.fusion = { ...s.fusion, ...fusionOverride };
  }

  s.df = new Map();
  s.chunks = texts.map((text, i) => {
    const tokens = s.tokenize.call(svc, text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of new Set(tokens)) s.df.set(t, (s.df.get(t) ?? 0) + 1);
    return { id: i + 1, text, vector: [], tf, len: tokens.length };
  });
  s.avgdl = s.chunks.reduce((sum, c) => sum + c.len, 0) / Math.max(1, s.chunks.length);
  s.isReady = true;

  // Векторный сигнал: отдаём заранее заданный порядок id (distance растёт по позиции).
  s.db = {
    prepare: () => ({
      all: (_vec: unknown, limit: number) =>
        vectorOrder.slice(0, limit).map((id, rank) => ({ id, distance: rank })),
    }),
  };
  s.embed = async () => [];

  return svc;
}

describe("RagService hybrid retrieval (vector + BM25, RRF)", () => {
  it("lexical signal rescues a chunk the vector ranking missed", async () => {
    // Чанк 3 содержит редкий артикул и лексически точен, но вектор ставит его последним.
    const texts = [
      "общая информация о студии и расписании работы",
      "как добраться до студии и где парковка",
      "услуга маникюр артикул XQ42 стоимость и длительность",
    ];
    const svc = ragWith(texts, [1, 2, 3]); // вектор: чанк 3 последний
    const out = await svc.search("сколько стоит XQ42", 2);

    expect(out.map((r) => r.text)).toContain(texts[2]);
  });

  it("agreement in both signals ranks a chunk first", async () => {
    const texts = [
      "запись на маникюр и педикюр онлайн",
      "прайс на услуги салона красоты",
      "контакты и адрес",
    ];
    const svc = ragWith(texts, [1, 2, 3]); // вектор: чанк 1 первый
    const out = await svc.search("хочу записаться на маникюр", 3);

    // Чанк 1 силён и по вектору (rank 0), и по BM25 ("маникюр"/"запись") → должен быть первым.
    expect(out[0].text).toBe(texts[0]);
    expect(out[0].score).toBe(1); // нормализация: топ всегда 1.0
  });

  it("respects fusion config: weightLexical=0 disables the lexical rescue", async () => {
    const texts = [
      "общая информация о студии и расписании работы",
      "как добраться до студии и где парковка",
      "услуга маникюр артикул XQ42 стоимость и длительность",
    ];
    // Тот же кейс, что и rescue-тест, но лексика отключена через конфиг → чанк 3 НЕ вытягивается.
    const svc = ragWith(texts, [1, 2, 3], { weightLexical: 0 });
    const out = await svc.search("сколько стоит XQ42", 2);

    expect(out.map((r) => r.text)).not.toContain(texts[2]);
  });

  it("returns empty when not ready or no chunks", async () => {
    const svc = ragWith([], []);
    expect(await svc.search("что угодно", 3)).toEqual([]);
  });

  it("normalizes fused scores into (0, 1]", async () => {
    const texts = ["маникюр и педикюр", "стрижка и окрашивание", "брови и ресницы"];
    const svc = ragWith(texts, [1, 2, 3]);
    const out = await svc.search("маникюр", 3);

    expect(out[0].score).toBe(1);
    for (const r of out) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});
