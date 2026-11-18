-- A write journal on Run, so an apply or rollback interrupted between its
-- first mutation and its final save can be reconciled against Shopify.
-- AlterTable
ALTER TABLE "Run" ADD COLUMN "writeStartedAt" DATETIME;
ALTER TABLE "Run" ADD COLUMN "writeHeartbeatAt" DATETIME;
ALTER TABLE "Run" ADD COLUMN "writePlanJson" TEXT;
