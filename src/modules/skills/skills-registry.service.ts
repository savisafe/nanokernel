import { Inject, Injectable, Logger } from "@nestjs/common";
import { LlmToolSpec, SKILL_PROVIDERS_TOKEN, Skill } from "./skill.contract";

@Injectable()
export class SkillsRegistry {
  private readonly logger = new Logger(SkillsRegistry.name);
  private readonly byName = new Map<string, Skill>();

  constructor(@Inject(SKILL_PROVIDERS_TOKEN) skills: Skill[]) {
    for (const s of skills) {
      if (this.byName.has(s.name)) {
        this.logger.warn(`Skill duplicate name "${s.name}" — keeping the first registration.`);
        continue;
      }
      this.byName.set(s.name, s);
    }
    this.logger.log(`Registered skills: ${[...this.byName.keys()].join(", ") || "(none)"}`);
  }

  get(name: string): Skill | undefined {
    return this.byName.get(name);
  }

  /** Резолвит skills для конкретного бота по списку имён (если каких-то нет — лог и пропуск). */
  resolveForBot(skillNames: readonly string[] | undefined): Skill[] {
    if (!skillNames || skillNames.length === 0) {
      return [];
    }
    const out: Skill[] = [];
    for (const name of skillNames) {
      const skill = this.byName.get(name);
      if (skill) {
        out.push(skill);
      } else {
        this.logger.warn(`Skill not found: "${name}" — ignoring.`);
      }
    }
    return out;
  }

  /** Сериализация skill в OpenAI-совместимый tool spec. */
  toToolSpec(skill: Skill): LlmToolSpec {
    return {
      name: skill.name,
      description: skill.description,
      parameters: skill.parameters,
    };
  }
}
