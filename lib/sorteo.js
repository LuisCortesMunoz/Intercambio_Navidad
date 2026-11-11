'use strict';

/*
 * Sorteo del intercambio: asignación global con restricciones.
 *
 * El problema es encontrar un emparejamiento perfecto en un grafo bipartito
 * (quien regala → quien recibe) donde una arista existe solo si la pareja está
 * permitida: nadie se regala a sí mismo, no hay regalos dentro de la misma
 * familia (si la regla está activa) y se respetan las restricciones particulares.
 *
 *  1. Factibilidad: emparejamiento máximo (algoritmo de Kuhn / caminos de aumento).
 *     Si no cubre a todos, no existe ninguna asignación válida y se explica por qué
 *     (condición de Hall: un grupo de personas con menos destinatarios posibles que miembros).
 *  2. Generación:
 *     a) Muestreo por rechazo: permutaciones al azar hasta encontrar una válida.
 *        Si funciona, el resultado es uniforme entre todas las asignaciones válidas.
 *     b) Si las reglas son muy restrictivas, asignación secuencial aleatoria con
 *        comprobación de extensibilidad: a cada persona se le da un destinatario al azar
 *        solo si las personas restantes todavía pueden completarse (emparejamiento perfecto).
 *        Nunca se queda nadie sin destinatario y no requiere retroceder.
 *  3. Validación independiente del resultado antes de guardarlo.
 *
 * Se usa crypto.randomInt (generador criptográfico) para todo el azar.
 */

const crypto = require('node:crypto');

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Normaliza las reglas.
 *  raw = { avoidSameFamily, familyOf: {personId: familyId} | Map, restrictions: [{giverId, receiverId, mutual}] }
 */
function normalizeRules(raw = {}) {
  const familyOf = raw.familyOf instanceof Map ? raw.familyOf : new Map(Object.entries(raw.familyOf || {}).map(([k, v]) => [Number(k), v]));
  const blocked = new Set();
  for (const r of raw.restrictions || []) {
    blocked.add(`${r.giverId}>${r.receiverId}`);
    if (r.mutual) blocked.add(`${r.receiverId}>${r.giverId}`);
  }
  return { avoidSameFamily: !!raw.avoidSameFamily, familyOf, blocked };
}

/** Motivo por el que giver no puede regalarle a receiver, o null si está permitido. */
function forbiddenReason(giverId, receiverId, rules) {
  if (giverId === receiverId) return 'self';
  if (rules.avoidSameFamily) {
    const fg = rules.familyOf.get(giverId);
    if (fg != null && fg === rules.familyOf.get(receiverId)) return 'family';
  }
  if (rules.blocked.has(`${giverId}>${receiverId}`)) return 'restriction';
  return null;
}

/** Map giverId -> array de receiverIds permitidos. */
function buildAllowed(ids, rules) {
  const allowed = new Map();
  for (const g of ids) allowed.set(g, ids.filter((r) => !forbiddenReason(g, r, rules)));
  return allowed;
}

/** Emparejamiento máximo (Kuhn). receivers: Set de destinatarios disponibles. */
function maxMatching(givers, receivers, allowed) {
  const matchR = new Map(); // receiver -> giver
  function augment(g, seen) {
    for (const r of allowed.get(g)) {
      if (!receivers.has(r) || seen.has(r)) continue;
      seen.add(r);
      if (!matchR.has(r) || augment(matchR.get(r), seen)) { matchR.set(r, g); return true; }
    }
    return false;
  }
  const unmatched = [];
  for (const g of givers) if (!augment(g, new Set())) unmatched.push(g);
  return { size: givers.length - unmatched.length, matchR, unmatched };
}

const joinNames = (list) => (list.length <= 1 ? list.join('')
  : `${list.slice(0, -1).join(', ')} y ${list[list.length - 1]}`);

/**
 * ¿Existe al menos una asignación válida? Si no, explica el motivo en español.
 * people: [{id, name}]
 */
function checkFeasibility(people, rawRules) {
  const rules = rawRules.blocked ? rawRules : normalizeRules(rawRules);
  const ids = people.map((p) => p.id);
  const name = new Map(people.map((p) => [p.id, p.name]));
  const n = ids.length;
  if (n < 2) {
    return { possible: false, problems: ['Se necesitan al menos 2 participantes para hacer el sorteo.'] };
  }
  const allowed = buildAllowed(ids, rules);
  const inDegree = new Map(ids.map((id) => [id, 0]));
  for (const g of ids) for (const r of allowed.get(g)) inDegree.set(r, inDegree.get(r) + 1);
  const outDegrees = ids.map((g) => allowed.get(g).length);
  const stats = { participants: n, minOptions: Math.min(...outDegrees), maxOptions: Math.max(...outDegrees) };

  const { size, matchR, unmatched } = maxMatching(ids, new Set(ids), allowed);
  if (size === n) return { possible: true, problems: [], stats };

  const problems = [];
  for (const g of ids) if (!allowed.get(g).length) problems.push(`${name.get(g)} no puede regalarle a nadie con las reglas actuales.`);
  for (const r of ids) if (!inDegree.get(r)) problems.push(`Nadie puede regalarle a ${name.get(r)} con las reglas actuales.`);

  if (rules.avoidSameFamily) {
    const byFamily = new Map();
    for (const id of ids) {
      const f = rules.familyOf.get(id);
      if (f != null) byFamily.set(f, [...(byFamily.get(f) || []), id]);
    }
    for (const members of byFamily.values()) {
      if (members.length > n - members.length) {
        problems.push(`Una familia tiene ${members.length} de ${n} participantes (${joinNames(members.map((m) => name.get(m)))}): `
          + `solo pueden regalarle a ${n - members.length} personas de otras familias.`);
      }
    }
  }

  if (!problems.length) {
    // Conjunto de Hall a partir de una persona sin destinatario: S personas con |N(S)| < |S|.
    const S = new Set([unmatched[0]]);
    const T = new Set();
    const queue = [unmatched[0]];
    while (queue.length) {
      const g = queue.shift();
      for (const r of allowed.get(g)) {
        if (T.has(r)) continue;
        T.add(r);
        const g2 = matchR.get(r);
        if (g2 != null && !S.has(g2)) { S.add(g2); queue.push(g2); }
      }
    }
    problems.push(`${joinNames([...S].map((id) => name.get(id)))} (${S.size} personas) solo pueden regalarle a `
      + `${T.size ? joinNames([...T].map((id) => name.get(id))) : 'nadie'} (${T.size} ${T.size === 1 ? 'persona' : 'personas'}). `
      + 'No alcanzan los destinatarios para todos.');
  }
  return { possible: false, problems, stats };
}

/**
 * Genera una asignación completa y válida.
 * Devuelve { ok: true, pairs: [{giverId, receiverId}], method } o { ok: false, problems }.
 */
function generateAssignment(people, rawRules, { rejectionAttempts = 20000 } = {}) {
  const rules = normalizeRules(rawRules);
  const feas = checkFeasibility(people, rules);
  if (!feas.possible) return { ok: false, problems: feas.problems };

  const ids = people.map((p) => p.id);
  const allowed = buildAllowed(ids, rules);
  const allowedSet = new Map(ids.map((g) => [g, new Set(allowed.get(g))]));
  let pairs = null;
  let method = 'rechazo';

  // a) Muestreo por rechazo (uniforme).
  for (let t = 0; t < rejectionAttempts && !pairs; t++) {
    const perm = shuffle(ids.slice());
    if (ids.every((g, i) => allowedSet.get(g).has(perm[i]))) {
      pairs = ids.map((g, i) => ({ giverId: g, receiverId: perm[i] }));
    }
  }

  // b) Secuencial aleatorio con comprobación de extensibilidad.
  if (!pairs) {
    method = 'secuencial';
    pairs = [];
    const remainingG = shuffle(ids.slice());
    const remainingR = new Set(ids);
    while (remainingG.length) {
      const g = remainingG.shift();
      let chosen = null;
      for (const r of shuffle(allowed.get(g).filter((x) => remainingR.has(x)))) {
        remainingR.delete(r);
        if (maxMatching(remainingG, remainingR, allowed).size === remainingG.length) { chosen = r; break; }
        remainingR.add(r);
      }
      // Imposible si la comprobación de factibilidad pasó; se deja por seguridad.
      if (chosen == null) return { ok: false, problems: ['No se pudo completar la asignación. Intenta de nuevo.'] };
      pairs.push({ giverId: g, receiverId: chosen });
    }
  }

  const v = validateAssignment(people, pairs, rules);
  if (!v.valid) return { ok: false, problems: v.errors };
  return { ok: true, pairs, method };
}

/**
 * Valida una asignación completa contra la lista de participantes y las reglas.
 * Devuelve { valid, errors, checks: [{key, label, ok}] }.
 */
function validateAssignment(people, pairs, rawRules) {
  const rules = rawRules.blocked ? rawRules : normalizeRules(rawRules);
  const name = new Map(people.map((p) => [p.id, p.name]));
  const nm = (id) => name.get(id) || `#${id}`;
  const errors = { complete: [], once: [], dup: [], self: [], rules: [] };

  const giverCount = new Map();
  const receiverCount = new Map();
  for (const { giverId, receiverId } of pairs) {
    if (!name.has(giverId)) errors.complete.push(`La asignación incluye a una persona que no participa (#${giverId}).`);
    if (!name.has(receiverId)) errors.once.push(`La asignación incluye un destinatario que no participa (#${receiverId}).`);
    giverCount.set(giverId, (giverCount.get(giverId) || 0) + 1);
    receiverCount.set(receiverId, (receiverCount.get(receiverId) || 0) + 1);
    if (giverId === receiverId) { errors.self.push(`${nm(giverId)} se regala a sí mismo(a).`); continue; }
    const why = forbiddenReason(giverId, receiverId, rules);
    if (why === 'family') errors.rules.push(`${nm(giverId)} le regala a ${nm(receiverId)}, de su misma familia.`);
    if (why === 'restriction') errors.rules.push(`${nm(giverId)} le regala a ${nm(receiverId)}, pero hay una restricción entre ellos.`);
  }
  for (const p of people) {
    const gc = giverCount.get(p.id) || 0;
    const rc = receiverCount.get(p.id) || 0;
    if (gc === 0) errors.complete.push(`${p.name} no tiene a quién regalar.`);
    if (gc > 1) errors.complete.push(`${p.name} tiene ${gc} asignaciones como quien regala.`);
    if (rc === 0) errors.once.push(`${p.name} no recibe ningún regalo.`);
    if (rc > 1) errors.dup.push(`${p.name} aparece ${rc} veces como destinatario.`);
  }

  const checks = [
    { key: 'complete', label: 'Todos los participantes tienen exactamente una asignación', ok: !errors.complete.length },
    { key: 'once', label: 'Todos reciben exactamente un regalo', ok: !errors.once.length && !errors.dup.length },
    { key: 'dup', label: 'No hay destinatarios duplicados', ok: !errors.dup.length },
    { key: 'self', label: 'Nadie se regala a sí mismo', ok: !errors.self.length },
    { key: 'rules', label: 'Se respetan las reglas de familia y las restricciones', ok: !errors.rules.length },
  ];
  const all = [...errors.complete, ...errors.once, ...errors.dup, ...errors.self, ...errors.rules];
  return { valid: all.length === 0, errors: all, checks };
}

module.exports = {
  normalizeRules, forbiddenReason, buildAllowed, maxMatching,
  checkFeasibility, generateAssignment, validateAssignment, shuffle,
};
