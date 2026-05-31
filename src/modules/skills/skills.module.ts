import { Global, Module } from "@nestjs/common";
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
      provide: SKILL_PROVIDERS_TOKEN,
      useFactory: (...skills: Skill[]) => skills,
      inject: [...SKILL_CLASSES],
    },
    SkillsRegistry,
  ],
  exports: [SkillsRegistry, DomainDataService, MestoClientService],
})
export class SkillsModule {}
