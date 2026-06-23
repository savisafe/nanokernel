import { Global, Module } from "@nestjs/common";
import { McpClientService } from "../mcp/mcp-client.service";
import { DomainDataService } from "./domain-data.service";
import { BookingNotifierService } from "./booking-notifier.service";
import { MestoClientService } from "./mesto-client.service";
import { BookingSyncService } from "./booking-sync.service";
import { SkillsRegistry } from "./skills-registry.service";
import { SKILL_PROVIDERS_TOKEN, Skill } from "./skill.contract";
import { LookupServiceSkill } from "./skills/lookup-service.skill";
import { LookupProductSkill } from "./skills/lookup-product.skill";
import { BookSlotSkill } from "./skills/book-slot.skill";
import { CheckAvailabilitySkill } from "./skills/check-availability.skill";
import { CancelBookingSkill } from "./skills/cancel-booking.skill";
import { RescheduleBookingSkill } from "./skills/reschedule-booking.skill";

const SKILL_CLASSES = [
  LookupServiceSkill,
  LookupProductSkill,
  BookSlotSkill,
  CheckAvailabilitySkill,
  CancelBookingSkill,
  RescheduleBookingSkill,
] as const;

@Global()
@Module({
  providers: [
    DomainDataService,
    BookingNotifierService,
    MestoClientService,
    BookingSyncService,
    ...SKILL_CLASSES,
    {
      // Единая точка сборки скиллов: статические builtin (Nest-провайдеры) +
      // внешние из MCP-серверов. Async-фабрика: Nest дожидается её до
      // конструирования SkillsRegistry, поэтому реестр видит все скиллы
      // одинаково (get() для FSM и makeDispatcher для LLM работают без правок).
      provide: SKILL_PROVIDERS_TOKEN,
      useFactory: async (mcp: McpClientService, ...builtins: Skill[]) => {
        const external = await mcp.loadSkills();
        return [...builtins, ...external];
      },
      inject: [McpClientService, ...SKILL_CLASSES],
    },
    SkillsRegistry,
  ],
  exports: [SkillsRegistry, DomainDataService, MestoClientService],
})
export class SkillsModule {}
