-- CreateTable
CREATE TABLE "ProcessedInboundMessage" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedInboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedInboundMessage_channel_externalMessageId_key" ON "ProcessedInboundMessage"("channel", "externalMessageId");
