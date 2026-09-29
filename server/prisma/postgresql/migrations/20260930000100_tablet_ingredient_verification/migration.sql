ALTER TABLE "BatchIngredient"
  ADD COLUMN "tabletTaskId" TEXT,
  ADD COLUMN "verificationStatus" TEXT,
  ADD COLUMN "verificationReason" TEXT;

CREATE INDEX "BatchIngredient_tabletTaskId_idx" ON "BatchIngredient"("tabletTaskId");
