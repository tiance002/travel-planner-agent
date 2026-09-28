ALTER TABLE "Trip" ADD COLUMN "genActiveUserId" TEXT;
ALTER TABLE "Trip" ADD COLUMN "genRunPhase" TEXT;
ALTER TABLE "Trip" ADD COLUMN "genRunConfig" TEXT;
ALTER TABLE "Trip" ADD COLUMN "genReviewId" TEXT;
-- 旧 checkpoint 没有可靠运行归属与配置，保留载荷并降级为人工恢复。
UPDATE "Trip" SET "genActiveUserId" = "userId",
  "genRunPhase" = CASE WHEN "genReview" IS NOT NULL THEN 'recovery' ELSE 'running' END
  WHERE "genRunId" IS NOT NULL;
-- Older failed review handlers could clear genRunId while leaving the review
-- payload.  Keep that payload available for the explicit recovery/cancel
-- path instead of leaving a phase-null row that no route can release.
UPDATE "Trip" SET "genRunPhase" = 'recovery',
  "genError" = COALESCE("genError", '旧裁决任务需要人工恢复或取消')
  WHERE "genReview" IS NOT NULL AND "genRunId" IS NULL;
-- 若旧库已出现同用户多个任务，失败并要求核实，不静默舍弃任务。
CREATE UNIQUE INDEX "Trip_genActiveUserId_key" ON "Trip"("genActiveUserId");
