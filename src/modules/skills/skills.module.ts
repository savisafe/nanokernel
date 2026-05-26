import { Global, Module } from "@nestjs/common";
import { DomainDataService } from "./domain-data.service";
import { SkillsRegistry } from "./skills-registry.service";
import { SKILL_PROVIDERS_TOKEN, Skill } from "./skill.contract";
import { LookupServiceSkill } from "./skills/lookup-service.skill";
import { LookupProductSkill } from "./skills/lookup-product.skill";

const SKILL_CLASSES = [LookupServiceSkill, LookupProductSkill] as const;

@Global()
@Module({
  providers: [
    DomainDataService,
    ...SKILL_CLASSES,
    {
      provide: SKILL_PROVIDERS_TOKEN,
      useFactory: (...skills: Skill[]) => skills,
      inject: [...SKILL_CLASSES],
    },
    SkillsRegistry,
  ],
  exports: [SkillsRegistry, DomainDataService],
})
export class SkillsModule {}
