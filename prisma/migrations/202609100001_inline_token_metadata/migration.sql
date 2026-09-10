-- Inline token metadata after synchronous IPFS upload.
ALTER TABLE "tokens"
  ADD COLUMN "ipfsUri" VARCHAR(512),
  ADD COLUMN "gatewayUrl" VARCHAR(2048),
  ADD COLUMN "socials" JSONB;

UPDATE "tokens" AS token
SET
  "ipfsUri" = operation."metadataUri",
  "gatewayUrl" = replace(operation."metadataUri", 'ipfs://', 'https://ipfs.io/ipfs/')
FROM "token_metadata_operations" AS operation
WHERE operation."tokenId" = token.id
  AND operation.status = 'READY'::"MetadataStatus"
  AND operation."metadataUri" IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "tokens" WHERE "ipfsUri" IS NULL OR "gatewayUrl" IS NULL) THEN
    RAISE EXCEPTION 'Cannot inline metadata while tokens without uploaded metadata exist; upload or remove those development rows first';
  END IF;
END
$$;

ALTER TABLE "tokens"
  ALTER COLUMN "ipfsUri" SET NOT NULL,
  ALTER COLUMN "gatewayUrl" SET NOT NULL;

DROP TABLE "token_metadata_operations";
DROP TYPE "MetadataStatus";

GRANT SELECT, INSERT, UPDATE, DELETE ON "tokens" TO spawn_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON "tokens" TO spawn_seed;
