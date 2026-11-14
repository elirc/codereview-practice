import { requireActor } from "@/server/auth/guards";
import { clock } from "@/server/clock";
import { json, readJson, route } from "@/server/http";
import { updateRuleBody } from "@/server/schemas";
import { serializeRule } from "@/server/serialize";
import { parseId } from "@/server/validation";
import { deleteRule, updateRule } from "@/services/availability";

export const PATCH = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  const ruleId = parseId(params.id, "Availability rule");
  const patch = await readJson(req, updateRuleBody);
  const result = await updateRule(actor, ruleId, patch, clock.now());
  return json({
    rule: serializeRule(result.rule),
    affectedAppointments: result.affectedAppointments,
  });
});

export const DELETE = route<{ id: string }>(async ({ req, params }) => {
  const actor = await requireActor(req);
  const ruleId = parseId(params.id, "Availability rule");
  const result = await deleteRule(actor, ruleId, clock.now());
  return json({ affectedAppointments: result.affectedAppointments });
});
