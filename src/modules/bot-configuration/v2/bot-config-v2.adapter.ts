import type { DialogConfigFileJson } from "../../dialog/dialog.config.types";
import type { PromptProfileFileJson } from "../../prompt-profile/prompt-profile.types";
import { interpolateTemplate } from "../../dialog/dialog-template.utils";
import type {
  ResolvedBotConfiguration,
  ResolvedBusinessInfo,
} from "../bot-configuration.types";
import type { BotConfigV2 } from "./bot-config-v2.types";
import { buildSystemPromptFromV2 } from "./system-prompt-builder";

/**
 * Преобразует v2 в текущий `ResolvedBotConfiguration`, ожидаемый pipeline (DialogService).
 *
 * v2 — это пользовательский фасад: декларативные поля persona/goals/guardrails/...
 * Внутренний пайплайн пока ничего не знает про v2 — он получает «short» dialog
 * с готовым `systemPrompt.template`, минимальный `promptProfile` и snippets.
 *
 * Плейсхолдеры `{managerName}`, `{address}`, `{phone}`, `{onlineBookingUrl}`,
 * `{workingHours}`, `{masters}`, `{servicesList}` подставляются в `persona.intro`
 * и в `snippets[*].reply` на этапе адаптации (один источник истины — businessInfo).
 */
export function adaptV2ToResolved(id: string, v2: BotConfigV2): ResolvedBotConfiguration {
  const language = v2.persona.language ?? "ru";
  const templateVars = buildTemplateVars(v2);

  const interpolatedIntro = v2.persona.intro
    ? interpolateTemplate(v2.persona.intro, templateVars)
    : undefined;
  const v2WithInterpolatedIntro: BotConfigV2 = interpolatedIntro
    ? { ...v2, persona: { ...v2.persona, intro: interpolatedIntro } }
    : v2;

  const promptProfile: PromptProfileFileJson = {
    companyName: v2.name,
    persona: v2.persona.role,
    language,
    humanLikeMode: v2.style?.humanLike ?? v2.persona.tone === "human" ? true : undefined,
  };

  const dialog: DialogConfigFileJson = {
    systemPrompt: { template: buildSystemPromptFromV2(v2WithInterpolatedIntro) },
    ...(v2.llm?.contextMessages !== undefined
      ? { contextMessages: v2.llm.contextMessages }
      : {}),
  };

  const llm =
    v2.llm?.temperature !== undefined || v2.llm?.maxTokens !== undefined
      ? {
          ...(v2.llm.temperature !== undefined ? { temperature: v2.llm.temperature } : {}),
          ...(v2.llm.maxTokens !== undefined ? { maxTokens: v2.llm.maxTokens } : {}),
        }
      : undefined;

  // Помощник: интерполирует строку через templateVars, если строка задана. FSM-плейсхолдеры
  // вида {service}, {date} в `vars` отсутствуют — interpolateTemplate их сохранит.
  const t = (s: string | undefined): string | undefined =>
    s ? interpolateTemplate(s, templateVars) : s;

  const guardrails =
    v2.guardrails &&
    (v2.guardrails.safetyChecks?.length ||
      v2.guardrails.refuseReply ||
      v2.guardrails.rateLimitReply ||
      v2.guardrails.llmFallbackReply ||
      v2.guardrails.rateLimit ||
      v2.guardrails.burstLimit ||
      v2.guardrails.repeatLimit ||
      v2.guardrails.maxReplyChars)
      ? {
          ...(v2.guardrails.safetyChecks?.length
            ? { safetyChecks: v2.guardrails.safetyChecks }
            : {}),
          ...(v2.guardrails.refuseReply ? { refuseReply: t(v2.guardrails.refuseReply)! } : {}),
          ...(v2.guardrails.rateLimitReply
            ? { rateLimitReply: t(v2.guardrails.rateLimitReply)! }
            : {}),
          ...(v2.guardrails.llmFallbackReply
            ? { llmFallbackReply: t(v2.guardrails.llmFallbackReply)! }
            : {}),
          ...(v2.guardrails.rateLimit ? { rateLimit: v2.guardrails.rateLimit } : {}),
          ...(v2.guardrails.burstLimit
            ? {
                burstLimit: {
                  ...v2.guardrails.burstLimit,
                  ...(v2.guardrails.burstLimit.reply
                    ? { reply: t(v2.guardrails.burstLimit.reply)! }
                    : {}),
                },
              }
            : {}),
          ...(v2.guardrails.repeatLimit
            ? {
                repeatLimit: {
                  ...v2.guardrails.repeatLimit,
                  ...(v2.guardrails.repeatLimit.reply
                    ? { reply: t(v2.guardrails.repeatLimit.reply)! }
                    : {}),
                },
              }
            : {}),
          ...(v2.guardrails.maxReplyChars !== undefined
            ? { maxReplyChars: v2.guardrails.maxReplyChars }
            : {}),
        }
      : undefined;

  const channel = v2.channel?.telegram
    ? { telegram: { ...v2.channel.telegram } }
    : undefined;

  // Подставляем плейсхолдеры в reply сниппетов на этапе адаптации (а не в matcher),
  // чтобы compileFor… кеш брал уже готовые тексты и не зависел от businessInfo.
  const snippets =
    v2.knowledge?.snippets && v2.knowledge.snippets.length > 0
      ? v2.knowledge.snippets.map((s) => ({
          ...s,
          reply: interpolateTemplate(s.reply, templateVars),
        }))
      : undefined;

  const persona =
    v2.persona.managerName || interpolatedIntro
      ? {
          role: v2.persona.role,
          ...(v2.persona.managerName ? { managerName: v2.persona.managerName } : {}),
          ...(interpolatedIntro ? { intro: interpolatedIntro } : {}),
        }
      : undefined;

  const businessInfo: ResolvedBusinessInfo | undefined = v2.businessInfo
    ? {
        ...(v2.businessInfo.address ? { address: v2.businessInfo.address } : {}),
        ...(v2.businessInfo.phone ? { phone: v2.businessInfo.phone } : {}),
        ...(v2.businessInfo.onlineBookingUrl
          ? { onlineBookingUrl: v2.businessInfo.onlineBookingUrl }
          : {}),
        ...(v2.businessInfo.workingHours
          ? { workingHours: v2.businessInfo.workingHours }
          : {}),
        ...(v2.businessInfo.masters && v2.businessInfo.masters.length > 0
          ? { masters: v2.businessInfo.masters }
          : {}),
        ...(v2.businessInfo.services && v2.businessInfo.services.length > 0
          ? { services: v2.businessInfo.services }
          : {}),
      }
    : undefined;

  // Скрипты: текстовые поля (ask, validateErrorReply, confirm, on*Reply, onCancel)
  // прогоняем через templateVars. ВАЖНО: если имя бизнес-переменной совпадает с именем
  // FSM-слота (например, и тут и там `phone`), исключаем такую переменную из карты,
  // чтобы плейсхолдер `{phone}` остался для ScriptRunnerService — он подставит туда
  // номер клиента из собранных слотов на runtime.
  const scripts =
    v2.scripts && Object.keys(v2.scripts).length > 0
      ? Object.fromEntries(
          Object.entries(v2.scripts).map(([name, def]) => {
            const slotNames = new Set(Object.keys(def.slots));
            const scopedVars = filterOut(templateVars, slotNames);
            const ts = (s: string | undefined): string | undefined =>
              s ? interpolateTemplate(s, scopedVars) : s;
            return [
              name,
              {
                ...def,
                slots: Object.fromEntries(
                  Object.entries(def.slots).map(([slotName, spec]) => [
                    slotName,
                    {
                      ...spec,
                      ask: ts(spec.ask) ?? spec.ask,
                      ...(spec.validateErrorReply
                        ? { validateErrorReply: ts(spec.validateErrorReply)! }
                        : {}),
                    },
                  ]),
                ),
                confirm: ts(def.confirm) ?? def.confirm,
                onConfirm: {
                  ...def.onConfirm,
                  successReply: ts(def.onConfirm.successReply) ?? def.onConfirm.successReply,
                  errorReply: ts(def.onConfirm.errorReply) ?? def.onConfirm.errorReply,
                },
                onCancel: ts(def.onCancel) ?? def.onCancel,
                ...(def.onMaxAttempts
                  ? { onMaxAttempts: ts(def.onMaxAttempts)! }
                  : {}),
              },
            ];
          }),
        )
      : undefined;

  return {
    id,
    llmPromptProfile: id,
    useRag: false,
    promptProfile,
    dialog,
    ...(snippets ? { snippets } : {}),
    ...(llm ? { llm } : {}),
    ...(v2.skills && v2.skills.length > 0 ? { skills: v2.skills } : {}),
    ...(scripts ? { scripts } : {}),
    ...(guardrails ? { guardrails } : {}),
    ...(channel ? { channel } : {}),
    ...(persona ? { persona } : {}),
    ...(businessInfo && Object.keys(businessInfo).length > 0
      ? { businessInfo }
      : {}),
    ...(v2.notifications && v2.notifications.telegramChatId !== undefined
      ? { notifications: { telegramChatId: v2.notifications.telegramChatId } }
      : {}),
    ...(v2.crm
      ? { crm: { provider: v2.crm.provider, baseUrl: v2.crm.baseUrl.replace(/\/+$/, ""), apiKeyEnv: v2.crm.apiKeyEnv } }
      : {}),
  };
}

/**
 * Карта `{placeholder}` → значение. Используется в `persona.intro` и
 * `snippets[*].reply`. Если поле не задано — плейсхолдер остаётся как есть
 * (interpolateTemplate возвращает оригинальный токен) — это видимо в логах
 * и быстрее ловится, чем «тихая» пустота.
 */
function buildTemplateVars(v2: BotConfigV2): Record<string, string> {
  const vars: Record<string, string> = {};
  if (v2.persona.managerName) vars.managerName = v2.persona.managerName;
  if (v2.businessInfo?.address) vars.address = v2.businessInfo.address;
  if (v2.businessInfo?.phone) vars.phone = v2.businessInfo.phone;
  if (v2.businessInfo?.onlineBookingUrl)
    vars.onlineBookingUrl = v2.businessInfo.onlineBookingUrl;
  if (v2.businessInfo?.workingHours) vars.workingHours = v2.businessInfo.workingHours;
  if (v2.businessInfo?.masters && v2.businessInfo.masters.length > 0) {
    vars.masters = v2.businessInfo.masters.join(", ");
  }
  if (v2.businessInfo?.services && v2.businessInfo.services.length > 0) {
    // {servicesList} — без цен (для «что у вас есть»). Цены показываем только по
    // явному запросу — через {servicesPriceList}.
    vars.servicesList = v2.businessInfo.services.map((s) => `• ${s.name}`).join("\n");
    vars.servicesPriceList = v2.businessInfo.services
      .map((s) => {
        const priceSuffix = s.price ? ` — ${s.price}` : "";
        return `• ${s.name}${priceSuffix}`;
      })
      .join("\n");
  }
  // Имя бизнеса/студии — берётся из top-level `name` v2, доступно как {companyName}.
  vars.companyName = v2.name;
  return vars;
}

function filterOut(
  vars: Record<string, string>,
  exclude: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (!exclude.has(k)) out[k] = v;
  }
  return out;
}
