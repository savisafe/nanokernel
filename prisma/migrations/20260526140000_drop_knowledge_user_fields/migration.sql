-- Drop legacy User columns tied to /new /done knowledge upload and mode picker:
-- knowledgeScopeText, knowledgeDraft, telegramKnowledgeAwaiting, selectedBotConfigurationId.
-- Functionality replaced by multi-bot routing (Phase 7) — each bot is its own
-- Telegram bot via channel.telegram in BotConfig v2.
ALTER TABLE "User" DROP COLUMN IF EXISTS "knowledgeScopeText";
ALTER TABLE "User" DROP COLUMN IF EXISTS "knowledgeDraft";
ALTER TABLE "User" DROP COLUMN IF EXISTS "telegramKnowledgeAwaiting";
ALTER TABLE "User" DROP COLUMN IF EXISTS "selectedBotConfigurationId";
