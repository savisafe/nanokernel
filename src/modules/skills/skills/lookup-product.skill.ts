import { Injectable } from "@nestjs/common";
import { DomainDataService } from "../domain-data.service";
import { Skill, SkillContext, SkillResult } from "../skill.contract";

interface PipeProduct {
  id: string;
  name: string;
  type: "профильная" | "круглая";
  material: "сталь" | "нержавейка" | "медь" | string;
  size?: string;
  diameter?: number;
  wallThickness?: number;
  lengthM?: number;
  price?: number;
}

/**
 * lookup_product — поиск трубы в каталоге.
 * Данные: `config/data/<botId>/products.json` (массив PipeProduct).
 */
@Injectable()
export class LookupProductSkill implements Skill {
  readonly name = "lookup_product";
  readonly description =
    "Найти трубу в каталоге по материалу, типу, диаметру и/или толщине стенки. Возвращает до 5 позиций с ценой.";
  readonly parameters = {
    type: "object",
    properties: {
      material: {
        type: "string",
        description: "Материал: сталь, нержавейка, медь и т.п.",
      },
      type: {
        type: "string",
        enum: ["профильная", "круглая"],
        description: "Тип сечения.",
      },
      diameter: {
        type: "number",
        description: "Диаметр в мм (для круглой) или сторона в мм (для профильной).",
      },
      wallThickness: {
        type: "number",
        description: "Толщина стенки в мм.",
      },
    },
  };

  constructor(private readonly data: DomainDataService) {}

  async execute(args: Record<string, unknown>, ctx: SkillContext): Promise<SkillResult> {
    const material =
      typeof args.material === "string" ? args.material.trim().toLowerCase() : undefined;
    const type = typeof args.type === "string" ? args.type.trim().toLowerCase() : undefined;
    const diameter = this.toNumber(args.diameter);
    const wallThickness = this.toNumber(args.wallThickness);

    const products = this.data.list<PipeProduct>(ctx.botId, "products");
    if (products.length === 0) {
      return { data: { error: "no product catalog configured for this bot" } };
    }

    const filtered = products.filter((p) => {
      if (material && !p.material.toLowerCase().includes(material)) {
        return false;
      }
      if (type && p.type !== type) {
        return false;
      }
      if (diameter !== undefined && p.diameter !== diameter) {
        // Допускаем профильную, если в size фигурирует число
        if (p.type === "профильная" && p.size && !p.size.includes(String(diameter))) {
          return false;
        }
        if (p.type === "круглая") {
          return false;
        }
      }
      if (wallThickness !== undefined && p.wallThickness !== wallThickness) {
        return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      return { data: { matches: [], note: "no matches" } };
    }

    return {
      data: {
        matches: filtered.slice(0, 5).map((p) => ({
          name: p.name,
          material: p.material,
          type: p.type,
          diameter: p.diameter,
          size: p.size,
          wallThickness: p.wallThickness,
          lengthM: p.lengthM,
          price: p.price,
        })),
      },
    };
  }

  private toNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value.trim());
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  }
}
