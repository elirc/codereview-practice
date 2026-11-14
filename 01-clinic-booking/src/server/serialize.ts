import type { AvailabilityException, AvailabilityRule, Clinic, Provider } from "@prisma/client";
import { fromDbDate } from "./dates";

export function serializeClinic(clinic: Clinic) {
  return {
    id: clinic.id,
    name: clinic.name,
    timezone: clinic.timezone,
    minLeadMinutes: clinic.minLeadMinutes,
    bookingHorizonDays: clinic.bookingHorizonDays,
  };
}

export function serializeProvider(provider: Provider) {
  return {
    id: provider.id,
    clinicId: provider.clinicId,
    displayName: provider.displayName,
    specialty: provider.specialty,
    active: provider.active,
  };
}

export function serializeRule(rule: AvailabilityRule) {
  return {
    id: rule.id,
    providerId: rule.providerId,
    weekday: rule.weekday,
    startLocal: rule.startLocal,
    endLocal: rule.endLocal,
    slotMinutes: rule.slotMinutes,
    validFrom: fromDbDate(rule.validFrom),
    validTo: rule.validTo ? fromDbDate(rule.validTo) : null,
  };
}

export function serializeException(exception: AvailabilityException) {
  return {
    id: exception.id,
    providerId: exception.providerId,
    localDate: fromDbDate(exception.localDate),
    kind: exception.kind,
    startLocal: exception.startLocal,
    endLocal: exception.endLocal,
    slotMinutes: exception.slotMinutes,
  };
}
