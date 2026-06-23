import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FeatureExtractionPipeline } from "@xenova/transformers";
import * as sqliteVec from "sqlite-vec";
import { PromptProfileService } from "../prompt-profile/prompt-profile.service";
import type { RetrievalFusionConfig } from "../prompt-profile/prompt-profile.types";
import { BotConfigurationService } from "../bot-configuration/bot-configuration.service";

// better-sqlite3 is a CommonJS native module (module.exports = Database). With
// esModuleInterop disabled, a default import would resolve to undefined at runtime,
// so a require() is the correct interop here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3");

interface VectorChunk {
  id: number;
  text: string;
  vector: number[];
  tf: Map<string, number>; // частоты термов в чанке (для BM25)
  len: number; // длина чанка в токенах
}

// Дефолтные параметры гибридного поиска (вектор + BM25, слияние через RRF).
// Переопределяются per-bot через profile.retrievalFusion (retrieval.fusion в JSON).
const DEFAULT_FUSION: RetrievalFusionConfig = {
  poolMultiplier: 5, // кандидатов из каждого сигнала = max(topK * множитель, poolMin)
  poolMin: 20,
  rrfK: 60, // классическая константа Reciprocal Rank Fusion
  weightVector: 1.0, // вектор важнее лексики
  weightLexical: 0.5,
};

// Параметры BM25.
const BM25_K1 = 1.5;
const BM25_B = 0.75;

@Injectable()
export class RagService implements OnModuleInit {
  private readonly logger = new Logger(RagService.name);
  private embeddingPipeline: FeatureExtractionPipeline | null = null;
  private db: any = null;
  private chunks: VectorChunk[] = [];
  private df = new Map<string, number>(); // document frequency по термам корпуса
  private avgdl = 0; // средняя длина чанка в токенах
  private fusion: RetrievalFusionConfig = DEFAULT_FUSION; // резолвится из профиля в indexKnowledgeBase
  private isReady = false;

  constructor(
    private readonly promptProfile: PromptProfileService,
    private readonly botConfiguration: BotConfigurationService,
  ) {}

  async onModuleInit() {
    const config = this.botConfiguration.get();
    if (!config.useRag) {
      this.logger.log("RAG disabled in configuration");
      return;
    }

    try {
      this.logger.log("Initializing RAG service...");

      // Инициализация SQLite с расширением vec
      this.db = new Database(":memory:");
      sqliteVec.load(this.db);

      // Создание таблицы для векторов
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING vec0(
          id INTEGER PRIMARY KEY,
          text TEXT NOT NULL,
          vector FLOAT[384]
        )
      `);

      // Загрузка модели эмбеддингов
      const { pipeline } = await import("@xenova/transformers");
      this.embeddingPipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");

      // Индексация базы знаний
      await this.indexKnowledgeBase();

      this.isReady = true;
      this.logger.log(`RAG service initialized with ${this.chunks.length} chunks`);
    } catch (error) {
      this.logger.error(
        `Failed to initialize RAG: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async indexKnowledgeBase() {
    const profile = this.promptProfile.getProfile();
    if (!profile.scopeText || profile.scopeText.trim().length === 0) {
      this.logger.warn("No scopeText available for RAG indexing");
      return;
    }

    const chunkSize = profile.retrievalChunkSize ?? 1600;
    const overlap = profile.retrievalChunkOverlap ?? 250;
    this.fusion = { ...DEFAULT_FUSION, ...(profile.retrievalFusion ?? {}) };
    const chunks = this.buildChunks(profile.scopeText, chunkSize, overlap);

    this.logger.log(`Indexing ${chunks.length} chunks...`);

    const insert = this.db.prepare(`
      INSERT INTO chunks (id, text, vector)
      VALUES (?, ?, ?)
    `);

    for (const chunk of chunks) {
      const vector = await this.embed(chunk.text);

      // Лексический индекс по тем же чанкам: частоты термов + document frequency.
      const tokens = this.tokenize(chunk.text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of new Set(tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1);

      this.chunks.push({ id: chunk.id, text: chunk.text, vector, tf, len: tokens.length });
      insert.run(BigInt(chunk.id), chunk.text, new Uint8Array(new Float32Array(vector).buffer));
    }

    this.avgdl = this.chunks.reduce((s, c) => s + c.len, 0) / Math.max(1, this.chunks.length);
  }

  /** Простой токенайзер для лексического сигнала: ё→е, нижний регистр, отброс коротких. */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/ё/g, "е")
      .split(/[^a-zа-я0-9]+/i)
      .filter((t) => t.length >= 2);
  }

  /** BM25-скоринг всех чанков по токенам запроса. Возвращает id, отсортированные по убыванию релевантности. */
  private bm25Ranked(queryTokens: string[]): number[] {
    const n = this.chunks.length;
    if (n === 0 || this.avgdl === 0) return [];

    const scored: Array<{ id: number; score: number }> = [];
    const uniqueQuery = new Set(queryTokens);
    for (const c of this.chunks) {
      let s = 0;
      for (const qt of uniqueQuery) {
        const f = c.tf.get(qt);
        if (!f) continue;
        const df = this.df.get(qt) ?? 0.5;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        s +=
          (idf * (f * (BM25_K1 + 1))) /
          (f + BM25_K1 * (1 - BM25_B + (BM25_B * c.len) / this.avgdl));
      }
      if (s > 0) scored.push({ id: c.id, score: s });
    }
    return scored.sort((a, b) => b.score - a.score).map((x) => x.id);
  }

  private buildChunks(
    text: string,
    chunkSize: number,
    overlap: number,
  ): Array<{ id: number; text: string }> {
    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (!normalized) return [];

    const chunks: Array<{ id: number; text: string }> = [];
    let start = 0;
    let id = 1;

    while (start < normalized.length) {
      const end = Math.min(normalized.length, start + chunkSize);
      const cut = this.findBoundary(normalized, start, end);
      const chunkText = normalized.slice(start, cut).trim();

      if (chunkText.length > 0) {
        chunks.push({ id, text: chunkText });
        id += 1;
      }

      if (cut >= normalized.length) break;
      start = Math.max(cut - overlap, start + 1);
    }

    return chunks;
  }

  private findBoundary(text: string, start: number, targetEnd: number): number {
    if (targetEnd >= text.length) return text.length;

    const breakpoints = ["\n\n", "\n", ". ", "; ", ", "];
    for (const point of breakpoints) {
      const idx = text.lastIndexOf(point, targetEnd);
      if (idx > start + 200) {
        return idx + point.length;
      }
    }
    return targetEnd;
  }

  private async embed(text: string): Promise<number[]> {
    if (!this.embeddingPipeline) {
      throw new Error("Embedding pipeline not initialized");
    }

    const output = await this.embeddingPipeline(text, {
      pooling: "mean",
      normalize: true,
    });

    return Array.from(output.data) as number[];
  }

  async search(query: string, topK: number = 3): Promise<Array<{ text: string; score: number }>> {
    if (!this.isReady || !this.db || this.chunks.length === 0) {
      return [];
    }

    const f = this.fusion;
    const pool = Math.max(topK * f.poolMultiplier, f.poolMin);

    // Сигнал 1: вектор (KNN из sqlite-vec). Берём только ранги — значения шкал не сравниваем.
    const queryVector = await this.embed(query);
    const vecRows = this.db
      .prepare(`SELECT id, distance FROM chunks WHERE vector MATCH ? ORDER BY distance LIMIT ?`)
      .all(new Uint8Array(new Float32Array(queryVector).buffer), pool) as Array<{
      id: number | bigint;
      distance: number;
    }>;
    const vecRanked = vecRows.map((r) => Number(r.id));

    // Сигнал 2: лексика (BM25) по тем же чанкам.
    const lexRanked = this.bm25Ranked(this.tokenize(query)).slice(0, pool);

    // Слияние через Reciprocal Rank Fusion: score(d) = Σ wᵢ / (k + rankᵢ).
    // Чанк, всплывший в обоих списках, суммирует вклады и поднимается выше ("agreement boost").
    const fused = new Map<number, number>();
    const addList = (ids: number[], weight: number): void => {
      if (weight <= 0) return; // сигнал отключён — не добавляем кандидатов со score 0
      ids.forEach((id, rank) => {
        fused.set(id, (fused.get(id) ?? 0) + weight / (f.rrfK + rank + 1));
      });
    };
    addList(vecRanked, f.weightVector);
    addList(lexRanked, f.weightLexical);

    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
    if (ranked.length === 0) return [];

    // Нормализация в [0,1] — чтобы presentation-шаблон (scorePercent) работал как прежде.
    const max = ranked[0][1] || 1;
    const textById = new Map(this.chunks.map((c) => [c.id, c.text]));
    return ranked
      .filter(([id]) => textById.has(id))
      .map(([id, score]) => ({ text: textById.get(id)!, score: score / max }));
  }

  isInitialized(): boolean {
    return this.isReady;
  }
}
