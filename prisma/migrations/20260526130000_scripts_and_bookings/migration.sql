-- AlterTable: FSM state per conversation
ALTER TABLE "Conversation" ADD COLUMN "activeScript" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "activeScriptState" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "activeScriptSlots" JSONB;

-- CreateTable: bookings (FSM action result)
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "conversationId" TEXT,
    "service" TEXT,
    "date" TEXT,
    "time" TEXT,
    "name" TEXT,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Booking_botId_createdAt_idx" ON "Booking"("botId", "createdAt");

-- CreateIndex
CREATE INDEX "Booking_phone_idx" ON "Booking"("phone");
