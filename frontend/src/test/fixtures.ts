/** Real plans, exported from the backend's replayed pipeline (backend/tests/test_frontend_fixtures.py). */
import { type Plan, Plan as PlanSchema, Rules } from "../api/schema";
import chicagoAtlanta from "./fixtures/chicago-atlanta.json";
import rules from "./fixtures/rules.json";
import sacramentoReno from "./fixtures/sacramento-reno.json";

export const PLANS: Record<string, Plan> = {
  "chicago-atlanta": PlanSchema.parse(chicagoAtlanta),
  "sacramento-reno": PlanSchema.parse(sacramentoReno),
};
export const RULES = Rules.parse(rules);
