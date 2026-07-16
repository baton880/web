ALTER TABLE "RtkTelemetry" ADD COLUMN "ingestKey" TEXT;

CREATE UNIQUE INDEX "RtkTelemetry_ingestKey_key" ON "RtkTelemetry"("ingestKey");
