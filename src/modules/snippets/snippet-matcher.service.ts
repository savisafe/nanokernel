import { Injectable, Logger } from "@nestjs/common";
import { ResolvedBotConfiguration } from "../bot-configuration/bot-configuration.types";
import { CompiledSnippet, SnippetHit, SnippetSpec } from "./snippet.types";

@Injectable()
export class SnippetMatcherService {
  private readonly logger = new Logger(SnippetMatcherService.name);
  private readonly compiledCache = new Map<string, CompiledSnippet[]>();

  match(text: string, bot: ResolvedBotConfiguration): SnippetHit | null {
    const compiled = this.compileForBot(bot);
    if (compiled.length === 0) {
      return null;
    }
    const normalized = this.normalize(text);
    if (!normalized) {
      return null;
    }
    for (const snippet of compiled) {
      if (snippet.test(normalized)) {
        return { id: snippet.id, reply: snippet.reply };
      }
    }
    return null;
  }

  private compileForBot(bot: ResolvedBotConfiguration): CompiledSnippet[] {
    const cached = this.compiledCache.get(bot.id);
    if (cached) {
      return cached;
    }
    const specs = bot.snippets ?? [];
    const compiled: CompiledSnippet[] = [];
    for (const spec of specs) {
      const item = this.compileSpec(spec, bot.id);
      if (item) {
        compiled.push(item);
      }
    }
    this.compiledCache.set(bot.id, compiled);
    return compiled;
  }

  private compileSpec(spec: SnippetSpec, botId: string): CompiledSnippet | null {
    if (!spec.id || !spec.reply || !Array.isArray(spec.match) || spec.match.length === 0) {
      this.logger.warn(
        `Snippet skipped (bot=${botId}, id=${spec.id ?? "?"}): missing id/reply/match`,
      );
      return null;
    }
    switch (spec.mode) {
      case "exact": {
        const needles = spec.match
          .map((m) => this.normalize(m))
          .filter((m): m is string => m.length > 0);
        if (needles.length === 0) {
          return null;
        }
        return {
          id: spec.id,
          reply: spec.reply,
          test: (t) => needles.some((n) => t.includes(n)),
        };
      }
      case "regex": {
        const flags = spec.flags ?? "iu";
        const regexes: RegExp[] = [];
        for (const pattern of spec.match) {
          try {
            regexes.push(new RegExp(pattern, flags));
          } catch (e) {
            this.logger.warn(
              `Snippet regex invalid (bot=${botId}, id=${spec.id}): ${pattern} — ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        if (regexes.length === 0) {
          return null;
        }
        return {
          id: spec.id,
          reply: spec.reply,
          test: (t) => regexes.some((r) => r.test(t)),
        };
      }
      case "keywords": {
        const groups: string[][] = [];
        for (const group of spec.match) {
          const words = this.normalize(group)
            .split(/\s+/)
            .filter((w) => w.length > 0);
          if (words.length > 0) {
            groups.push(words);
          }
        }
        if (groups.length === 0) {
          return null;
        }
        return {
          id: spec.id,
          reply: spec.reply,
          test: (t) => groups.some((words) => words.every((w) => t.includes(w))),
        };
      }
      default: {
        this.logger.warn(
          `Snippet skipped (bot=${botId}, id=${spec.id}): unknown mode "${spec.mode}"`,
        );
        return null;
      }
    }
  }

  private normalize(text: string): string {
    return text.trim().toLowerCase().replace(/ё/g, "е");
  }
}
