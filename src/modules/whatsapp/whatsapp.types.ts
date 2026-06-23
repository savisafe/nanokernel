export interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          from?: string;
          id?: string;
          text?: {
            body?: string;
          };
          type?: string;
        }>;
      };
    }>;
  }>;
}

export interface IncomingWhatsAppMessage {
  from: string;
  text: string;
  messageId?: string;
}
