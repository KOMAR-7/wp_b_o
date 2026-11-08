-- R6.8: Central WhatsApp Account Management & Restaurant Mapping
-- Drop single active constraint to allow multiple active central accounts
DROP INDEX IF EXISTS "central_whatsapp_accounts_single_active_idx";

-- Alter central_whatsapp_accounts to add management & diagnostic fields
ALTER TABLE "central_whatsapp_accounts" ADD COLUMN IF NOT EXISTS "account_name" VARCHAR(255) NOT NULL DEFAULT 'Central WhatsApp Account';
ALTER TABLE "central_whatsapp_accounts" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "central_whatsapp_accounts" ADD COLUMN IF NOT EXISTS "verification_status" VARCHAR(64) DEFAULT 'UNVERIFIED';
ALTER TABLE "central_whatsapp_accounts" ADD COLUMN IF NOT EXISTS "last_tested_at" TIMESTAMPTZ;
ALTER TABLE "central_whatsapp_accounts" ADD COLUMN IF NOT EXISTS "verification_error" TEXT;
ALTER TABLE "central_whatsapp_accounts" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ;

-- Index for soft deleted accounts
CREATE INDEX IF NOT EXISTS "central_whatsapp_accounts_deleted_at_idx" ON "central_whatsapp_accounts"("deleted_at");

-- Add central_account_id foreign key column to restaurants table
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "central_account_id" UUID;

-- Index for fast lookup of restaurants by central_account_id
CREATE INDEX IF NOT EXISTS "restaurants_central_account_id_idx" ON "restaurants"("central_account_id");

-- Foreign key constraint with ON DELETE SET NULL to preserve restaurant data if account is safely deleted
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'restaurants_central_account_id_fkey'
    ) THEN
        ALTER TABLE "restaurants" 
        ADD CONSTRAINT "restaurants_central_account_id_fkey" 
        FOREIGN KEY ("central_account_id") 
        REFERENCES "central_whatsapp_accounts"("id") 
        ON DELETE SET NULL 
        ON UPDATE CASCADE;
    END IF;
END $$;

