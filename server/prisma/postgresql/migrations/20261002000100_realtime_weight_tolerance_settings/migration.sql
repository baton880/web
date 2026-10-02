ALTER TABLE "TelemetrySettings"
ADD COLUMN "tabletAlgorithmWeightTolerancePercent" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN "tabletAlgorithmWeightToleranceMinKg" INTEGER NOT NULL DEFAULT 5;
