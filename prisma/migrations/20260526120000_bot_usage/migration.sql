-- CreateTable
CREATE TABLE "BotUsage" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "conversationId" TEXT,
    "kind" TEXT NOT NULL,
    "snippetId" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotUsage_botId_createdAt_idx" ON "BotUsage"("botId", "createdAt");

-- CreateIndex
CREATE INDEX "BotUsage_createdAt_idx" ON "BotUsage"("createdAt");

-- CreateIndex
CREATE INDEX "BotUsage_botId_kind_createdAt_idx" ON "BotUsage"("botId", "kind", "createdAt");
