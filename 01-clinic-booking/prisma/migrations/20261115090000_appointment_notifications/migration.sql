-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('CANCELLATION', 'RESCHEDULED');

-- CreateTable
CREATE TABLE "appointment_notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "appointment_id" UUID NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "status" "ReminderStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimed_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "appointment_notifications_appointment_id_kind_key" ON "appointment_notifications"("appointment_id", "kind");

-- CreateIndex
CREATE INDEX "appointment_notifications_status_created_at_idx" ON "appointment_notifications"("status", "created_at");

-- AddForeignKey
ALTER TABLE "appointment_notifications" ADD CONSTRAINT "appointment_notifications_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "appointment_notifications"
    ADD CONSTRAINT "appointment_notifications_attempts_check" CHECK ("attempts" >= 0);
