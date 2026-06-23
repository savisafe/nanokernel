import { IncomingTelegramMessage } from "../telegram/telegram.types";
import { IncomingWhatsAppMessage } from "../whatsapp/whatsapp.types";

export type DialogInboundJob =
  | ({ channel: "telegram"; botId: string } & IncomingTelegramMessage)
  | ({ channel: "whatsapp" } & IncomingWhatsAppMessage)
  | { channel: "http"; sessionId: string; text: string };
