-- AlterTable: per-master executor + computed price on bookings
ALTER TABLE "Booking" ADD COLUMN "master" TEXT;
ALTER TABLE "Booking" ADD COLUMN "amount" INTEGER;
