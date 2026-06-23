import { Body, Controller, Get, Headers, Post, Query, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { WhatsAppService } from "./whatsapp.service";
import { WhatsAppWebhookPayload } from "./whatsapp.types";

@Controller("webhooks/whatsapp")
export class WhatsAppController {
  constructor(private readonly whatsAppService: WhatsAppService) {}

  @Get()
  verify(
    @Query("hub.mode") mode?: string,
    @Query("hub.verify_token") token?: string,
    @Query("hub.challenge") challenge?: string,
    @Res() res?: Response,
  ) {
    const verified = this.whatsAppService.verifyWebhook(mode, token, challenge);
    if (verified === null) {
      return res?.status(403).send("Forbidden");
    }
    return res?.status(200).send(verified);
  }

  @Post()
  async webhook(
    @Body() payload: WhatsAppWebhookPayload,
    @Headers("x-hub-signature-256") signature?: string,
    @Req() req?: Request & { rawBody?: Buffer },
    @Res() res?: Response,
  ) {
    const valid = this.whatsAppService.verifySignature(req?.rawBody, signature);
    if (!valid) {
      return res?.status(401).send("Invalid signature");
    }
    await this.whatsAppService.handleIncoming(payload);
    return res?.status(200).send("EVENT_RECEIVED");
  }
}
