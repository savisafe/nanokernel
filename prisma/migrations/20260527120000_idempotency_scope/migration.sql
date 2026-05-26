-- Add chat-scope to ProcessedInboundMessage uniqueness key.
-- Telegram messageId is unique only per-chat; without scope two chats with the
-- same numeric messageId would dedup against each other and the second message
-- would be silently dropped.

ALTER TABLE "ProcessedInboundMessage" ADD COLUMN "scope" TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS "ProcessedInboundMessage_channel_externalMessageId_key";

CREATE UNIQUE INDEX "ProcessedInboundMessage_channel_scope_externalMessageId_key"
  ON "ProcessedInboundMessage" ("channel", "scope", "externalMessageId");
