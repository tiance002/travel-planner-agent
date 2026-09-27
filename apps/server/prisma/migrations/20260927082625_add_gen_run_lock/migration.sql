-- AlterTable
ALTER TABLE "Trip" ADD COLUMN "genHeartbeatAt" DATETIME;
ALTER TABLE "Trip" ADD COLUMN "genRunId" TEXT;
ALTER TABLE "Trip" ADD COLUMN "genRunStartedAt" DATETIME;

-- CreateIndex
CREATE INDEX "Trip_status_genHeartbeatAt_idx" ON "Trip"("status", "genHeartbeatAt");
