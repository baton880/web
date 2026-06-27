ALTER TABLE "RationIngredient" ADD COLUMN "isCompound" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RationIngredient" ADD COLUMN "componentsJson" TEXT;
