-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'ACCEPTED', 'UNCERTAIN_DISPATCH', 'DELIVERED', 'READ', 'FAILED', 'SUPPRESSED');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "confirmation_token" VARCHAR(128);

-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "claimed_by" VARCHAR(64),
ADD COLUMN     "lease_expires_at" TIMESTAMPTZ,
ADD COLUMN     "lease_token" UUID;

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "recipient_phone" VARCHAR(32) NOT NULL,
    "message_type" VARCHAR(32) NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_messages_idempotency_key_key" ON "outbox_messages"("idempotency_key");

-- CreateIndex
CREATE INDEX "outbox_messages_status_created_at_idx" ON "outbox_messages"("status", "created_at");

-- CreateIndex
CREATE INDEX "outbox_messages_restaurant_id_status_idx" ON "outbox_messages"("restaurant_id", "status");

-- CreateIndex
CREATE INDEX "outbox_messages_restaurant_id_created_at_idx" ON "outbox_messages"("restaurant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_confirmation_token_key" ON "orders"("confirmation_token");

-- CreateIndex
CREATE INDEX "webhook_events_processing_status_lease_expires_at_idx" ON "webhook_events"("processing_status", "lease_expires_at");

-- AddForeignKey
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

