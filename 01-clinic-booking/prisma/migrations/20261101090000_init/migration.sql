-- btree_gist provides the equality operator class used by the exclusion constraints below.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PATIENT', 'PROVIDER', 'STAFF', 'ADMIN');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('BOOKED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "ExceptionKind" AS ENUM ('CLOSED', 'CUSTOM_HOURS');

-- CreateEnum
CREATE TYPE "ReminderKind" AS ENUM ('T24H', 'T2H');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "clinics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "min_lead_minutes" INTEGER NOT NULL DEFAULT 60,
    "booking_horizon_days" INTEGER NOT NULL DEFAULT 90,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "clinic_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "timezone" TEXT NOT NULL,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "providers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "clinic_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "specialty" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_local" VARCHAR(5) NOT NULL,
    "end_local" VARCHAR(5) NOT NULL,
    "slot_minutes" INTEGER NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_exceptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "local_date" DATE NOT NULL,
    "kind" "ExceptionKind" NOT NULL,
    "start_local" VARCHAR(5),
    "end_local" VARCHAR(5),
    "slot_minutes" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'BOOKED',
    "reason" VARCHAR(500),
    "booked_by_user_id" UUID NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_user_id" UUID,
    "cancel_reason" VARCHAR(500),
    "late_cancel" BOOLEAN NOT NULL DEFAULT false,
    "rescheduled_from_id" UUID,
    "idempotency_key" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "appointment_id" UUID NOT NULL,
    "kind" "ReminderKind" NOT NULL,
    "scheduled_for" TIMESTAMPTZ(3) NOT NULL,
    "status" "ReminderStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimed_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "last_error" TEXT,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "patients_user_id_key" ON "patients"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "providers_user_id_key" ON "providers"("user_id");

-- CreateIndex
CREATE INDEX "providers_clinic_id_idx" ON "providers"("clinic_id");

-- CreateIndex
CREATE INDEX "availability_rules_provider_id_weekday_idx" ON "availability_rules"("provider_id", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "availability_exceptions_provider_id_local_date_key" ON "availability_exceptions"("provider_id", "local_date");

-- CreateIndex
CREATE INDEX "appointments_provider_id_starts_at_idx" ON "appointments"("provider_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_patient_id_starts_at_idx" ON "appointments"("patient_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "reminders_appointment_id_kind_key" ON "reminders"("appointment_id", "kind");

-- CreateIndex
CREATE INDEX "reminders_status_scheduled_for_idx" ON "reminders"("status", "scheduled_for");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "providers" ADD CONSTRAINT "providers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "providers" ADD CONSTRAINT "providers_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_booked_by_user_id_fkey" FOREIGN KEY ("booked_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_rescheduled_from_id_fkey" FOREIGN KEY ("rescheduled_from_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Invariants Prisma cannot express in the schema file.
ALTER TABLE "clinics"
    ADD CONSTRAINT "clinics_min_lead_minutes_check" CHECK ("min_lead_minutes" >= 0),
    ADD CONSTRAINT "clinics_booking_horizon_days_check" CHECK ("booking_horizon_days" >= 1);

ALTER TABLE "users"
    ADD CONSTRAINT "users_email_lowercase_check" CHECK ("email" = lower("email")),
    ADD CONSTRAINT "users_clinic_membership_check" CHECK (
        ("role" IN ('PROVIDER', 'STAFF') AND "clinic_id" IS NOT NULL)
        OR ("role" IN ('PATIENT', 'ADMIN') AND "clinic_id" IS NULL)
    );

ALTER TABLE "availability_rules"
    ADD CONSTRAINT "availability_rules_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7),
    ADD CONSTRAINT "availability_rules_slot_minutes_check" CHECK ("slot_minutes" IN (15, 20, 30, 45, 60)),
    ADD CONSTRAINT "availability_rules_time_format_check" CHECK (
        "start_local" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "end_local" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    ),
    ADD CONSTRAINT "availability_rules_window_check" CHECK ("start_local" < "end_local"),
    ADD CONSTRAINT "availability_rules_validity_check" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from");

ALTER TABLE "availability_exceptions"
    ADD CONSTRAINT "availability_exceptions_shape_check" CHECK (
        ("kind" = 'CLOSED' AND "start_local" IS NULL AND "end_local" IS NULL AND "slot_minutes" IS NULL)
        OR (
            "kind" = 'CUSTOM_HOURS'
            AND "start_local" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND "end_local" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND "start_local" < "end_local"
            AND "slot_minutes" IN (15, 20, 30, 45, 60)
        )
    );

ALTER TABLE "appointments"
    ADD CONSTRAINT "appointments_time_order_check" CHECK ("ends_at" > "starts_at"),
    ADD CONSTRAINT "appointments_provider_no_overlap" EXCLUDE USING gist (
        "provider_id" WITH =,
        tstzrange("starts_at", "ends_at", '[)') WITH &&
    ) WHERE ("status" = 'BOOKED'),
    ADD CONSTRAINT "appointments_patient_no_overlap" EXCLUDE USING gist (
        "patient_id" WITH =,
        tstzrange("starts_at", "ends_at", '[)') WITH &&
    ) WHERE ("status" = 'BOOKED');

CREATE UNIQUE INDEX "appointments_patient_idempotency_key" ON "appointments"("patient_id", "idempotency_key")
    WHERE "idempotency_key" IS NOT NULL;

ALTER TABLE "reminders"
    ADD CONSTRAINT "reminders_attempts_check" CHECK ("attempts" >= 0);
