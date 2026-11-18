-- CreateTable
CREATE TABLE "PolicyRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "json" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "policyJson" TEXT NOT NULL,
    "policyHash" TEXT NOT NULL,
    "optionsJson" TEXT NOT NULL,
    "dataBasisJson" TEXT NOT NULL,
    "summaryJson" TEXT NOT NULL,
    "rowsJson" TEXT NOT NULL,
    "applyJson" TEXT,
    "rollbackJson" TEXT,
    "rolledBackAt" DATETIME
);

-- CreateTable
CREATE TABLE "PriceChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fromCents" INTEGER NOT NULL,
    "toCents" INTEGER NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "PolicyRecord_shop_createdAt_idx" ON "PolicyRecord"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "Run_shop_createdAt_idx" ON "Run"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "PriceChange_shop_variantId_idx" ON "PriceChange"("shop", "variantId");

-- CreateIndex
CREATE INDEX "PriceChange_runId_idx" ON "PriceChange"("runId");

