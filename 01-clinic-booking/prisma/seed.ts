import { PrismaClient, type Role } from "@prisma/client";
import { DateTime } from "luxon";
import { planReminders } from "../src/domain/reminders";
import { addDays, isoWeekday, localDateOf, resolveLocal } from "../src/domain/time";
import { hashPassword } from "../src/server/auth/password";

const db = new PrismaClient();

const SEED_PASSWORD = "clinic-demo-pass";

function seedId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const CLINICS = [
  { id: seedId(1), name: "Harbour Clinic", timezone: "America/New_York" },
  { id: seedId(2), name: "Bayside Clinic", timezone: "America/Los_Angeles" },
];

const PROVIDERS = [
  {
    email: "dr.lee@clinic.test",
    clinicId: seedId(1),
    displayName: "Dr. Mina Lee",
    specialty: "General practice",
    windows: [
      { weekdays: [1, 2, 3, 4, 5], startLocal: "09:00", endLocal: "12:00", slotMinutes: 30 },
      { weekdays: [1, 2, 3, 4, 5], startLocal: "13:00", endLocal: "17:00", slotMinutes: 30 },
    ],
  },
  {
    email: "dr.patel@clinic.test",
    clinicId: seedId(1),
    displayName: "Dr. Arjun Patel",
    specialty: "Physiotherapy",
    windows: [{ weekdays: [2, 4], startLocal: "08:00", endLocal: "12:00", slotMinutes: 60 }],
  },
  {
    email: "dr.garcia@clinic.test",
    clinicId: seedId(2),
    displayName: "Dr. Sofia Garcia",
    specialty: "Pediatrics",
    windows: [
      { weekdays: [1, 2, 3, 4, 5], startLocal: "08:00", endLocal: "12:00", slotMinutes: 20 },
    ],
  },
];

const PATIENTS = [
  { email: "ana@patient.test", fullName: "Ana Silva", timezone: "America/New_York" },
  { email: "kenji@patient.test", fullName: "Kenji Sato", timezone: "Asia/Tokyo" },
];

async function upsertUser(
  email: string,
  role: Role,
  clinicId: string | null,
  passwordHash: string,
) {
  return db.user.upsert({
    where: { email },
    update: {},
    create: { email, role, clinicId, passwordHash },
  });
}

/** The first weekday after today in `zone`, `offset` working days ahead. */
function workingDayAhead(zone: string, offset: number): string {
  let date = localDateOf(DateTime.utc(), zone);
  let remaining = offset;
  while (remaining > 0) {
    date = addDays(date, 1);
    if (isoWeekday(date) <= 5) remaining -= 1;
  }
  return date;
}

async function upsertAppointment(
  id: string,
  data: {
    providerId: string;
    patientId: string;
    bookedByUserId: string;
    startsAt: DateTime;
    minutes: number;
    status: "BOOKED" | "COMPLETED";
    reason: string;
  },
) {
  const existing = await db.appointment.findUnique({ where: { id } });
  if (existing) return existing;
  const appointment = await db.appointment.create({
    data: {
      id,
      providerId: data.providerId,
      patientId: data.patientId,
      bookedByUserId: data.bookedByUserId,
      startsAt: data.startsAt.toJSDate(),
      endsAt: data.startsAt.plus({ minutes: data.minutes }).toJSDate(),
      status: data.status,
      reason: data.reason,
    },
  });
  if (data.status === "BOOKED") {
    await db.reminder.createMany({
      data: planReminders(data.startsAt, DateTime.utc()).map((reminder) => ({
        appointmentId: id,
        kind: reminder.kind,
        scheduledFor: reminder.scheduledFor.toJSDate(),
      })),
      skipDuplicates: true,
    });
  }
  return appointment;
}

function at(date: string, time: string, zone: string): DateTime {
  const instant = resolveLocal(date, time, zone);
  if (!instant) throw new Error(`${date} ${time} does not exist in ${zone}`);
  return instant;
}

async function main(): Promise<void> {
  const passwordHash = await hashPassword(SEED_PASSWORD);

  for (const clinic of CLINICS) {
    await db.clinic.upsert({ where: { id: clinic.id }, update: {}, create: clinic });
  }

  await upsertUser("admin@clinic.test", "ADMIN", null, passwordHash);
  await upsertUser("staff.harbour@clinic.test", "STAFF", seedId(1), passwordHash);
  await upsertUser("staff.bayside@clinic.test", "STAFF", seedId(2), passwordHash);

  const providerIds: string[] = [];
  let ruleNumber = 100;
  for (const spec of PROVIDERS) {
    const user = await upsertUser(spec.email, "PROVIDER", spec.clinicId, passwordHash);
    const provider = await db.provider.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        clinicId: spec.clinicId,
        displayName: spec.displayName,
        specialty: spec.specialty,
      },
    });
    providerIds.push(provider.id);
    for (const window of spec.windows) {
      for (const weekday of window.weekdays) {
        ruleNumber += 1;
        await db.availabilityRule.upsert({
          where: { id: seedId(ruleNumber) },
          update: {},
          create: {
            id: seedId(ruleNumber),
            providerId: provider.id,
            weekday,
            startLocal: window.startLocal,
            endLocal: window.endLocal,
            slotMinutes: window.slotMinutes,
            validFrom: new Date("2026-01-01T00:00:00.000Z"),
          },
        });
      }
    }
  }

  const patients = [];
  for (const spec of PATIENTS) {
    const user = await upsertUser(spec.email, "PATIENT", null, passwordHash);
    const patient = await db.patient.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, fullName: spec.fullName, timezone: spec.timezone },
    });
    patients.push({ user, patient });
  }

  const [lee, , garcia] = providerIds;
  const [ana, kenji] = patients;
  const harbourZone = CLINICS[0].timezone;
  const baysideZone = CLINICS[1].timezone;

  const closedDay = new Date(`${workingDayAhead(harbourZone, 5)}T00:00:00Z`);
  await db.availabilityException.upsert({
    where: { providerId_localDate: { providerId: lee, localDate: closedDay } },
    update: {},
    create: { providerId: lee, localDate: closedDay, kind: "CLOSED" },
  });

  await upsertAppointment(seedId(500), {
    providerId: lee,
    patientId: ana.patient.id,
    bookedByUserId: ana.user.id,
    startsAt: at(workingDayAhead(harbourZone, 2), "10:00", harbourZone),
    minutes: 30,
    status: "BOOKED",
    reason: "Annual check-up",
  });
  await upsertAppointment(seedId(501), {
    providerId: garcia,
    patientId: kenji.patient.id,
    bookedByUserId: kenji.user.id,
    startsAt: at(workingDayAhead(baysideZone, 3), "09:00", baysideZone),
    minutes: 20,
    status: "BOOKED",
    reason: "Vaccination follow-up",
  });
  await upsertAppointment(seedId(502), {
    providerId: lee,
    patientId: ana.patient.id,
    bookedByUserId: ana.user.id,
    startsAt: at("2026-01-05", "09:00", harbourZone),
    minutes: 30,
    status: "COMPLETED",
    reason: "Flu symptoms",
  });

  console.log("Seed complete. All accounts use the password:", SEED_PASSWORD);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
