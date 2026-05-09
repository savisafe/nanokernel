export interface TelegramApiMessage {
  message_id?: number;
  text?: string;
  caption?: string;
  chat?: {
    id?: number;
    type?: string;
  };
  from?: {
    id?: number;
    first_name?: string;
    username?: string;
  };
  document?: {
    file_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  photo?: Array<{ file_id?: string; file_unique_id?: string }>;
  voice?: { file_id?: string };
  audio?: { file_id?: string };
  video?: { file_id?: string };
  video_note?: { file_id?: string };
  sticker?: { file_id?: string };
}

export interface TelegramWebhookPayload {
  update_id?: number;
  message?: TelegramApiMessage;
  channel_post?: TelegramApiMessage;
  edited_message?: TelegramApiMessage;
}

export type TelegramUnsupportedAttachment =
  | "photo"
  | "voice"
  | "audio"
  | "video"
  | "video_note"
  | "sticker";

export interface TelegramInboundDocument {
  fileId: string;
  fileName?: string;
  mimeType?: string;
}

export interface IncomingTelegramMessage {
  chatId: number;
  text: string;
  messageId?: number;
  document?: TelegramInboundDocument;
  unsupportedAttachment?: TelegramUnsupportedAttachment;
}
