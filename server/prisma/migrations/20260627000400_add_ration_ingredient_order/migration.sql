ALTER TABLE "RationIngredient" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

UPDATE "RationIngredient"
SET "sortOrder" = (
  SELECT COUNT(*)
  FROM "RationIngredient" AS "ordered"
  WHERE "ordered"."rationId" = "RationIngredient"."rationId"
    AND "ordered"."id" <= "RationIngredient"."id"
);
