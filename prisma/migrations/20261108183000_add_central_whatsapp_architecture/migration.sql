-- CreateEnum
CREATE TYPE "SenderChannel" AS ENUM ('RESTAURANT', 'CENTRAL');

-- AlterTable
ALTER TABLE "outbox_messages" ADD COLUMN "sender_channel" "SenderChannel" NOT NULL DEFAULT 'RESTAURANT';

-- CreateIndex
CREATE INDEX "outbox_messages_sender_channel_status_idx" ON "outbox_messages"("sender_channel", "status");

-- CreateTable
CREATE TABLE "central_whatsapp_accounts" (
    "id" UUID NOT NULL,
    "phone_number_id" VARCHAR(64) NOT NULL,
    "waba_id" VARCHAR(64) NOT NULL,
    "display_phone_number" VARCHAR(32),
    "access_token_encrypted" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "central_whatsapp_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "central_whatsapp_accounts_phone_number_id_key" ON "central_whatsapp_accounts"("phone_number_id");

-- CreateIndex
CREATE INDEX "central_whatsapp_accounts_is_active_idx" ON "central_whatsapp_accounts"("is_active");

-- Enforce single active central account at database level
CREATE UNIQUE INDEX "central_whatsapp_accounts_single_active_idx" ON "central_whatsapp_accounts"("is_active") WHERE "is_active" = true;

