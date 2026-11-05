-- DropForeignKey
ALTER TABLE "order_notifications" DROP CONSTRAINT "order_notifications_order_id_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "orders_id_restaurant_id_key" ON "orders"("id", "restaurant_id");

-- AddForeignKey
ALTER TABLE "order_notifications" ADD CONSTRAINT "order_notifications_order_id_restaurant_id_fkey" FOREIGN KEY ("order_id", "restaurant_id") REFERENCES "orders"("id", "restaurant_id") ON DELETE CASCADE ON UPDATE CASCADE;
