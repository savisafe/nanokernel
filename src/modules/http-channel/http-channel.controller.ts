import { Body, Controller, Post } from "@nestjs/common";
import { HttpChannelService } from "./http-channel.service";

interface MessageBody {
  sessionId?: string;
  text?: string;
}

/**
 * Минимальный HTTP-вход для агента: `POST /channels/http/message` с `{sessionId, text}`
 * → `{reply}`. Диалог прогоняется синхронно (без очереди), ответ — в теле HTTP.
 */
@Controller("channels/http")
export class HttpChannelController {
  constructor(private readonly svc: HttpChannelService) {}

  @Post("message")
  async message(@Body() body: MessageBody): Promise<{ reply: string }> {
    const sessionId = (body?.sessionId ?? "").trim() || "default";
    const text = (body?.text ?? "").trim();
    if (text.length === 0) {
      return { reply: "" };
    }
    const reply = await this.svc.handle(sessionId, text);
    return { reply };
  }
}
