// engine.js — aplica reglas §5 al Event normalizado, leyendo del store (CONTRACT-V2 §1)
//
// Las reglas viven ahora en el almacén persistente (config/store.js); los defaults
// de rules/defaults.js sólo sirven como seed inicial. La semántica de "regla aplicada"
// (setPriority + procedureId) se mantiene, y además se expone el objeto de la regla
// que casó para que el motor de dispatch pueda leer actions.dispatchMode/skills/operatorIds.

import { getRules, getProcedure as storeGetProcedure } from "../config/store.js";

// ¿El evento cumple el match de la regla? El match v2 puede tener type/category/
// deviceId/siteId como arrays; un array vacío (o ausente) no restringe.
function matches(event, match) {
  if (!match) return true;
  const checks = [
    ["type", event.type],
    ["category", event.category],
    ["target", event.target],
    ["deviceId", event.source?.deviceId],
    ["siteId", event.siteId ?? event.source?.siteId],
  ];
  for (const [key, val] of checks) {
    const cond = match[key];
    if (Array.isArray(cond) && cond.length > 0) {
      if (!cond.includes(val)) return false;
    }
  }
  return true;
}

// Aplica la primera regla (orden asc) que coincide: setPriority (si existe) + procedureId.
// Muta el evento y devuelve { event, rule } donde rule es el objeto v2 que casó (o null).
export function applyRules(event, rules = getRules()) {
  for (const rule of rules) {
    if (matches(event, rule.match)) {
      const actions = rule.actions || {};
      if (actions.setPriority != null) event.priority = actions.setPriority;
      if (actions.procedureId) event.procedureId = actions.procedureId;
      event._ruleId = rule.id; // referencia interna (no canónica)
      return { event, rule };
    }
  }
  return { event, rule: null };
}

export function getProcedure(id) {
  return storeGetProcedure(id);
}

export { getRules };
export default applyRules;
