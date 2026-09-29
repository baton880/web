ALTER TABLE "BatchIngredient" ADD COLUMN "tabletTaskId" TEXT;
ALTER TABLE "BatchIngredient" ADD COLUMN "verificationStatus" TEXT;
ALTER TABLE "BatchIngredient" ADD COLUMN "verificationReason" TEXT;

CREATE INDEX "BatchIngredient_tabletTaskId_idx" ON "BatchIngredient"("tabletTaskId");
