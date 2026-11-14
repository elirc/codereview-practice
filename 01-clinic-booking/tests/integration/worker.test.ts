import type { ReminderKind, ReminderStatus } from "@prisma/client";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { MemoryMailer } from "@/server/mailer";
import { dispatchNotifications, sendNotification } from "@/worker/notifications";
import { dispatchReminders, sendReminder } from "@/worker/reminders";
import { createClinic, createPatient, createProvider, insertAppointment } from "./helpers";

const NOW = DateTime.fromISO("2026-07-06T12:00:00Z", { zone: "utc" });

async function scenario() {
  const clinic = await createClinic({ name: "Harbour Clinic", timezone: "America/New_York" });
  const provider = await createProvider(clinic.id, { displayName: "Dr. Lee" });
  const patient = await createPatient({ timezone: "America/New_York", fullName: "Ana Silva" });

  async function appointment(startsAt: DateTime, status: "BOOKED" | "CANCELLED" = "BOOKED") {
    return insertAppointment({
      providerId: provider.providerId,
      patientId: patient.patientId,
      bookedByUserId: patient.userId,
      startsAt: startsAt.toJSDate().toISOString(),
      status,
    });
  }

  async function reminder(
    appointmentId: string,
    kind: ReminderKind,
    scheduledFor: DateTime,
    extra: { status?: ReminderStatus; claimedAt?: DateTime; attempts?: number } = {},
  ) {
    return db.reminder.create({
      data: {
        appointmentId,
        kind,
        scheduledFor: scheduledFor.toJSDate(),
        status: extra.status ?? "PENDING",
        claimedAt: extra.claimedAt?.toJSDate() ?? null,
        attempts: extra.attempts ?? 0,
      },
    });
  }

  return { patient, appointment, reminder };
}

async function dispatch(now = NOW) {
  const enqueued: string[] = [];
  const result = await dispatchReminders({
    db,
    log: logger,
    now,
    enqueue: async (queue, data) => {
      expect(queue).toBe("reminders.send");
      enqueued.push((data as { reminderId: string }).reminderId);
    },
  });
  return { result, enqueued };
}

async function dispatchEmails(now = NOW) {
  const jobs: [string, string][] = [];
  const result = await dispatchNotifications({
    db,
    log: logger,
    now,
    enqueue: async (queue, data) => {
      jobs.push([queue, (data as { notificationId: string }).notificationId]);
    },
  });
  return { result, jobs };
}

function notify(appointmentId: string, kind: "CANCELLATION" | "RESCHEDULED") {
  return db.appointmentNotification.create({ data: { appointmentId, kind } });
}

function sendEmail(mailer: MemoryMailer, notificationId: string, now = NOW) {
  return sendNotification({ db, mailer, log: logger, now }, notificationId);
}

function send(mailer: MemoryMailer, reminderId: string, now = NOW) {
  return sendReminder({ db, mailer, log: logger, now }, reminderId);
}

async function statusOf(reminderId: string) {
  return (await db.reminder.findUniqueOrThrow({ where: { id: reminderId } })).status;
}

describe("reminder dispatch", () => {
  it("claims due reminders and enqueues one send each, leaving future ones alone", async () => {
    const { appointment, reminder } = await scenario();
    const appt = await appointment(NOW.plus({ hours: 26 }));
    const later = await appointment(NOW.plus({ days: 3 }));
    const due = await reminder(appt.id, "T24H", NOW.minus({ hours: 2 }));
    const dueNow = await reminder(later.id, "T2H", NOW);
    const future = await reminder(later.id, "T24H", NOW.plus({ days: 2 }));

    const { result, enqueued } = await dispatch();

    expect(result).toEqual({ reset: 0, claimed: 2, enqueued: 2 });
    expect(enqueued.sort()).toEqual([due.id, dueNow.id].sort());
    const claimed = await db.reminder.findUniqueOrThrow({ where: { id: due.id } });
    expect(claimed.status).toBe("SENDING");
    expect(claimed.claimedAt?.toISOString()).toBe("2026-07-06T12:00:00.000Z");
    expect(await statusOf(future.id)).toBe("PENDING");
  });

  it("returns claims older than ten minutes to the queue and reclaims them", async () => {
    const { appointment, reminder } = await scenario();
    const appt = await appointment(NOW.plus({ hours: 2 }));
    const stuck = await reminder(appt.id, "T24H", NOW.minus({ minutes: 20 }), {
      status: "SENDING",
      claimedAt: NOW.minus({ minutes: 11 }),
    });
    const inFlight = await reminder(appt.id, "T2H", NOW.minus({ minutes: 1 }), {
      status: "SENDING",
      claimedAt: NOW.minus({ minutes: 5 }),
    });

    const { result, enqueued } = await dispatch();

    expect(result.reset).toBe(1);
    expect(enqueued).toEqual([stuck.id]);
    const reclaimed = await db.reminder.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(reclaimed.claimedAt?.toISOString()).toBe("2026-07-06T12:00:00.000Z");
    const untouched = await db.reminder.findUniqueOrThrow({ where: { id: inFlight.id } });
    expect(untouched.claimedAt?.toISOString()).toBe("2026-07-06T11:55:00.000Z");
  });
});

describe("reminder sending", () => {
  it("sends a claimed reminder to the patient and marks it SENT", async () => {
    const { appointment, reminder, patient } = await scenario();
    const appt = await appointment(NOW.plus({ hours: 2 }));
    const due = await reminder(appt.id, "T2H", NOW, { status: "SENDING", claimedAt: NOW });
    const mailer = new MemoryMailer();

    expect(await send(mailer, due.id)).toBe("sent");

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe(patient.email);
    expect(mailer.sent[0].text).toContain("Monday, July 6, 2026 at 10:00 AM EDT");
    const row = await db.reminder.findUniqueOrThrow({ where: { id: due.id } });
    expect(row.status).toBe("SENT");
    expect(row.sentAt?.toISOString()).toBe("2026-07-06T12:00:00.000Z");
  });

  it("skips a reminder whose appointment was cancelled after it was claimed", async () => {
    const { appointment, reminder } = await scenario();
    const appt = await appointment(NOW.plus({ hours: 2 }), "CANCELLED");
    const due = await reminder(appt.id, "T2H", NOW, { status: "SENDING", claimedAt: NOW });
    const mailer = new MemoryMailer();

    expect(await send(mailer, due.id)).toBe("skipped");
    expect(mailer.sent).toHaveLength(0);
    expect(await statusOf(due.id)).toBe("SKIPPED");
  });

  it("skips a day-before reminder left stale by an outage but sends a recent one", async () => {
    const { appointment, reminder } = await scenario();
    const tomorrow = await appointment(NOW.plus({ hours: 21 }));
    const soon = await appointment(NOW.plus({ hours: 1, minutes: 50 }));
    const stale = await reminder(tomorrow.id, "T24H", NOW.minus({ hours: 3 }));
    const recent = await reminder(soon.id, "T2H", NOW.minus({ minutes: 10 }));
    const mailer = new MemoryMailer();

    const { enqueued } = await dispatch();
    for (const id of enqueued) await send(mailer, id);

    expect(await statusOf(stale.id)).toBe("SKIPPED");
    expect(await statusOf(recent.id)).toBe("SENT");
    expect(mailer.sent).toHaveLength(1);
  });

  it("retries failed deliveries and marks the reminder FAILED after five attempts", async () => {
    const { appointment, reminder } = await scenario();
    const appt = await appointment(NOW.plus({ hours: 2 }));
    const due = await reminder(appt.id, "T2H", NOW.minus({ minutes: 1 }));
    const mailer = new MemoryMailer();
    mailer.failNext(5);

    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const { enqueued } = await dispatch();
      for (const id of enqueued) outcomes.push(await send(mailer, id));
    }

    expect(outcomes).toEqual(["retry", "retry", "retry", "retry", "failed"]);
    const row = await db.reminder.findUniqueOrThrow({ where: { id: due.id } });
    expect(row).toMatchObject({
      status: "FAILED",
      attempts: 5,
      lastError: "mail provider unavailable",
    });
    expect(mailer.sent).toHaveLength(0);
  });

  it("ignores a reminder that is no longer claimed", async () => {
    const { appointment, reminder } = await scenario();
    const appt = await appointment(NOW.plus({ hours: 2 }));
    const sent = await reminder(appt.id, "T2H", NOW, { status: "SENT" });
    const mailer = new MemoryMailer();

    expect(await send(mailer, sent.id)).toBe("ignored");
    expect(mailer.sent).toHaveLength(0);
  });
});

describe("appointment notifications", () => {
  it("dispatches each pending notice to its queue once and sends it to the patient", async () => {
    const { appointment, patient } = await scenario();
    const original = await appointment(NOW.plus({ days: 2 }), "CANCELLED");
    const moved = await db.appointment.update({
      where: { id: (await appointment(NOW.plus({ days: 3 }))).id },
      data: { rescheduledFromId: original.id },
    });
    const cancellation = await notify(original.id, "CANCELLATION");
    const rescheduled = await notify(moved.id, "RESCHEDULED");
    const mailer = new MemoryMailer();

    const { result, jobs } = await dispatchEmails();
    expect(result).toEqual({ reset: 0, claimed: 2, enqueued: 2 });
    expect(Object.fromEntries(jobs.map(([queue, id]) => [id, queue]))).toEqual({
      [cancellation.id]: "email.cancellation",
      [rescheduled.id]: "email.rescheduled",
    });
    for (const [, id] of jobs) expect(await sendEmail(mailer, id)).toBe("sent");

    expect((await dispatchEmails()).jobs).toEqual([]);
    expect(await sendEmail(mailer, cancellation.id)).toBe("ignored");
    expect(mailer.sent.map((m) => m.to)).toEqual([patient.email, patient.email]);
    const subjects = mailer.sent.map((m) => m.subject);
    expect(subjects).toContain("Your appointment with Dr. Lee has been cancelled");
    const notice = mailer.sent.find((m) => m.subject.includes("rescheduled"));
    expect(notice?.text).toContain("is now on Thursday, July 9, 2026 at 8:00 AM EDT");
    expect(notice?.text).toContain("replaces the appointment on Wednesday, July 8, 2026");
    const rows = await db.appointmentNotification.findMany();
    expect(rows.every((row) => row.status === "SENT" && row.sentAt !== null)).toBe(true);
  });

  it("retries failed notices and marks them FAILED after five attempts", async () => {
    const { appointment } = await scenario();
    const cancelled = await appointment(NOW.plus({ days: 2 }), "CANCELLED");
    const row = await notify(cancelled.id, "CANCELLATION");
    const mailer = new MemoryMailer();
    mailer.failNext(5);

    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const { jobs } = await dispatchEmails();
      for (const [, id] of jobs) outcomes.push(await sendEmail(mailer, id));
    }

    expect(outcomes).toEqual(["retry", "retry", "retry", "retry", "failed"]);
    const stored = await db.appointmentNotification.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored).toMatchObject({ status: "FAILED", attempts: 5 });
  });

  it("returns a claim that was never sent to the queue after ten minutes", async () => {
    const { appointment } = await scenario();
    const cancelled = await appointment(NOW.plus({ days: 2 }), "CANCELLED");
    const row = await notify(cancelled.id, "CANCELLATION");

    await dispatchEmails(NOW.minus({ minutes: 11 }));
    const { result, jobs } = await dispatchEmails();

    expect(result.reset).toBe(1);
    expect(jobs).toEqual([["email.cancellation", row.id]]);
  });
});
