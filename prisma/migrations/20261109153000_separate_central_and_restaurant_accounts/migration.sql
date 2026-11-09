-- R6.9: Separation of Central WhatsApp Accounts and Restaurant Tenants
-- Add account classification and ownership columns to restaurants table
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "is_platform_account" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "account_type" VARCHAR(64) NOT NULL DEFAULT 'RESTAURANT';

-- Indexes for fast filtering
CREATE INDEX IF NOT EXISTS "restaurants_is_platform_account_idx" ON "restaurants"("is_platform_account");
CREATE INDEX IF NOT EXISTS "restaurants_account_type_idx" ON "restaurants"("account_type");

-- 1. Classify known platform test records created during staging verification
UPDATE "restaurants"
SET "is_platform_account" = true,
    "account_type" = 'PLATFORM_TEST'
WHERE "name" IN (
    'UI Assignment Test Bistro',
    'DB Integrity Test Cafe',
    'Webhook Verification Bistro'
)
OR ("waba_id" = '1620323530136933' AND "phone_number_id" LIKE '1427%' AND "name" != 'RestPro');

-- 2. Classify canonical Central WhatsApp account records in restaurants table
UPDATE "restaurants"
SET "is_platform_account" = true,
    "account_type" = 'PLATFORM_CENTRAL'
WHERE "phone_number_id" IN (
    SELECT "phone_number_id" FROM "central_whatsapp_accounts"
)
OR "phone_number_id" = '1427497060448125'
OR "name" = 'RestPro';
