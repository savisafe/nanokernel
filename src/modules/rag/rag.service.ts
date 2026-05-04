import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { FeatureExtractionPipeline } from "@xenova/transformers";
import * as sqliteVec from "sqlite-vec";
import { PromptProfileService } from "../prompt-profile/prompt-profile.service";
import { BotConfigurationService } from "../bot-configuration/bot-configuration.service";

const Database = require("better-sqlite3");

interface VectorChunk {
  id: number;
  text: string;
  vector: number[];
}

@Injectable()
export class RagService implements OnModuleInit {
  private readonly logger = new Logger(RagService.name);
  private embeddingPipeline: FeatureExtractionPipeline | null = null;
  private db: any = null;
  private chunks: VectorChunk[] = [];
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
      this.embeddingPipeline = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
      );

      // Индексация базы знаний
      await this.indexKnowledgeBase();

      this.isReady = true;
      this.logger.log(`RAG service initialized with ${this.chunks.length} chunks`);
    } catch (error) {
      this.logger.error(`Failed to initialize RAG: ${error instanceof Error ? error.message : String(error)}`);
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
    const chunks = this.buildChunks(profile.scopeText, chunkSize, overlap);

    this.logger.log(`Indexing ${chunks.length} chunks...`);

    const insert = this.db.prepare(`
      INSERT INTO chunks (id, text, vector)
      VALUES (?, ?, ?)
    `);

    for (const chunk of chunks) {
      const vector = await this.embed(chunk.text);
      this.chunks.push({ id: chunk.id, text: chunk.text, vector });
      insert.run(BigInt(chunk.id), chunk.text, new Uint8Array(new Float32Array(vector).buffer));
    }
  }

  private buildChunks(text: string, chunkSize: number, overlap: number): Array<{ id: number; text: string }> {
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

    const queryVector = await this.embed(query);
    
    // Поиск через sqlite-vec
    const stmt = this.db.prepare(`
      SELECT text, distance
      FROM chunks
      WHERE vector MATCH ?
      ORDER BY distance
      LIMIT ?
    `);

    const rows = stmt.all(new Uint8Array(new Float32Array(queryVector).buffer), topK) as Array<{ text: string; distance: number }>;
    
    // distance = 1 - cosine_similarity
    return rows.map((row) => ({
      text: row.text,
      score: 1 - row.distance,
    }));
  }

  isInitialized(): boolean {
    return this.isReady;
  }
}
