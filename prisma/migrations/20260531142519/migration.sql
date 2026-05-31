-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "mestoAppointmentId" TEXT,
ADD COLUMN     "mestoClientId" TEXT,
ADD COLUMN     "syncStatus" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "syncedAt" TIMESTAMP(3);
