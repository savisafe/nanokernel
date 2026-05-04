import { IncomingTelegramMessage } from "../telegram/telegram.types";
import { IncomingWhatsAppMessage } from "../whatsapp/whatsapp.types";

export type DialogInboundJob =
  | ({ channel: "telegram" } & IncomingTelegramMessage)
  | ({ channel: "whatsapp" } & IncomingWhatsAppMessage);

export function buildDialogInboundJobId(job: DialogInboundJob): string | undefined {
  if (job.channel === "telegram" && job.messageId != null) {
    return `telegram-${job.messageId}`;
  }
  if (job.channel === "whatsapp" && job.messageId) {
    const safe = job.messageId.replace(/:/g, "-");
    return `whatsapp-${safe}`;
  }
  return undefined;
}
