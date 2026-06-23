-- AlterTable
ALTER TABLE "User" ADD COLUMN     "knowledgeScopeText" TEXT,
ADD COLUMN     "knowledgeDraft" TEXT,
ADD COLUMN     "telegramKnowledgeAwaiting" BOOLEAN NOT NULL DEFAULT false;
