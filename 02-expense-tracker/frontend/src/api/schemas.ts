import { z } from "zod";

export const roleSchema = z.enum(["employee", "manager", "finance", "admin"]);
export const reportStatusSchema = z.enum([
  "draft",
  "submitted",
  "approved",
  "rejected",
  "reimbursed",
]);
export const categorySchema = z.enum(["travel", "meals", "lodging", "supplies", "other"]);

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  full_name: z.string(),
  role: roleSchema,
  manager_id: z.string().nullable(),
  approval_limit_minor: z.number().int(),
  active: z.boolean(),
});

export const meSchema = z.object({ user: userSchema, base_currency: z.string() });

export const userSummarySchema = z.object({ id: z.string(), full_name: z.string() });

export const currencySchema = z.object({ code: z.string(), exponent: z.number().int() });

export const receiptSchema = z.object({
  id: z.string(),
  original_filename: z.string(),
  content_type: z.string(),
  size_bytes: z.number().int(),
  sha256: z.string(),
  created_at: z.string(),
});

export const lineSchema = z.object({
  id: z.string(),
  expense_date: z.string(),
  category: categorySchema,
  description: z.string(),
  amount_minor: z.number().int(),
  currency: z.string(),
  receipt_id: z.string().nullable(),
  receipt: receiptSchema.nullable(),
  rate_used: z.string().nullable(),
  rate_effective_date: z.string().nullable(),
  base_amount_minor: z.number().int().nullable(),
  estimated_base_minor: z.number().int().nullable(),
  needs_receipt: z.boolean(),
});

export const stepSchema = z.object({
  id: z.string(),
  round: z.number().int(),
  position: z.number().int(),
  kind: z.enum(["manager", "finance"]),
  status: z.enum(["pending", "approved", "rejected", "skipped"]),
  approver: userSummarySchema.nullable(),
  decided_by: userSummarySchema.nullable(),
  decided_at: z.string().nullable(),
  comment: z.string().nullable(),
});

export const reportSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: reportStatusSchema,
  owner: userSummarySchema,
  round: z.number().int(),
  version: z.number().int(),
  total_base_minor: z.number().int().nullable(),
  base_currency: z.string(),
  submitted_at: z.string().nullable(),
  decided_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const reportDetailSchema = reportSummarySchema.extend({
  estimated_total_base_minor: z.number().int().nullable(),
  lines: z.array(lineSchema),
  steps: z.array(stepSchema),
  current_step_id: z.string().nullable(),
  reimbursement: z
    .object({
      id: z.string(),
      amount_base_minor: z.number().int(),
      currency: z.string(),
      payment_reference: z.string(),
      paid_by: z.string(),
      paid_at: z.string(),
    })
    .nullable(),
  can: z.object({
    edit: z.boolean(),
    submit: z.boolean(),
    withdraw: z.boolean(),
    decide: z.boolean(),
    reopen: z.boolean(),
    reimburse: z.boolean(),
  }),
});

export const pendingApprovalSchema = reportSummarySchema.extend({
  current_step_id: z.string(),
  current_step_kind: z.enum(["manager", "finance"]),
  current_step_position: z.number().int(),
});

export const bulkApproveResultSchema = z.object({ approved: z.array(z.string()) });

export const rateSchema = z.object({
  id: z.string(),
  from_currency: z.string(),
  effective_date: z.string(),
  rate: z.string(),
  in_use: z.boolean(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const auditEventSchema = z.object({
  id: z.number().int(),
  at: z.string(),
  actor: userSummarySchema.nullable(),
  request_id: z.string().nullable(),
  entity_type: z.string(),
  entity_id: z.string(),
  report_id: z.string().nullable(),
  action: z.string(),
  before: z.record(z.unknown()).nullable(),
  after: z.record(z.unknown()).nullable(),
});

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), limit: z.number().int(), offset: z.number().int() });
}

export type Role = z.infer<typeof roleSchema>;
export type ReportStatus = z.infer<typeof reportStatusSchema>;
export type Category = z.infer<typeof categorySchema>;
export type User = z.infer<typeof userSchema>;
export type Me = z.infer<typeof meSchema>;
export type Currency = z.infer<typeof currencySchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type Line = z.infer<typeof lineSchema>;
export type Step = z.infer<typeof stepSchema>;
export type ReportSummary = z.infer<typeof reportSummarySchema>;
export type ReportDetail = z.infer<typeof reportDetailSchema>;
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;
export type Rate = z.infer<typeof rateSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
