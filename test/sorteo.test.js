'use strict';

// Pruebas del algoritmo de asignación: `npm test`
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  generateAssignment, validateAssignment, checkFeasibility, normalizeRules, forbiddenReason,
} = require('../lib/sorteo');

const makePeople = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Persona ${i + 1}` }));

/** Comprobación independiente (no usa validateAssignment) de que el resultado es correcto. */
function assertValid(people, pairs, rawRules) {
  const rules = normalizeRules(rawRules);
  const ids = people.map((p) => p.id).sort((a, b) => a - b);
  assert.equal(pairs.length, people.length, 'una asignación por participante');
  const givers = pairs.map((p) => p.giverId).sort((a, b) => a - b);
  const receivers = pairs.map((p) => p.receiverId).sort((a, b) => a - b);
  assert.deepEqual(givers, ids, 'cada participante regala exactamente una vez');
  assert.deepEqual(receivers, ids, 'cada participante recibe exactamente una vez (sin duplicados)');
  assert.equal(new Set(receivers).size, ids.length, 'ningún destinatario repetido');
  for (const { giverId, receiverId } of pairs) {
    assert.notEqual(giverId, receiverId, 'nadie se regala a sí mismo');
    assert.equal(forbiddenReason(giverId, receiverId, rules), null, `pareja prohibida ${giverId}→${receiverId}`);
  }
}

test('sin reglas: 500 sorteos de tamaños 2–40 siempre válidos', () => {
  for (let t = 0; t < 500; t++) {
    const people = makePeople(2 + (t % 39));
    const r = generateAssignment(people, {});
    assert.ok(r.ok, r.problems?.join(' '));
    assertValid(people, r.pairs, {});
  }
});

test('con 2 personas, se regalan entre ellas', () => {
  const r = generateAssignment(makePeople(2), {});
  assert.ok(r.ok);
  assert.deepEqual(r.pairs.map((p) => [p.giverId, p.receiverId]).sort(), [[1, 2], [2, 1]]);
});

test('menos de 2 participantes: imposible', () => {
  assert.equal(generateAssignment(makePeople(1), {}).ok, false);
  assert.equal(generateAssignment([], {}).ok, false);
});

test('regla de familias: nunca se regala dentro de la misma familia (1000 sorteos)', () => {
  const people = makePeople(12);
  // 4 familias de 3
  const familyOf = Object.fromEntries(people.map((p) => [p.id, Math.ceil(p.id / 3)]));
  const rules = { avoidSameFamily: true, familyOf };
  for (let t = 0; t < 1000; t++) {
    const r = generateAssignment(people, rules);
    assert.ok(r.ok);
    assertValid(people, r.pairs, rules);
    for (const { giverId, receiverId } of r.pairs) assert.notEqual(familyOf[giverId], familyOf[receiverId]);
  }
});

test('restricciones particulares (en un sentido y en ambos) se respetan', () => {
  const people = makePeople(6);
  const rules = {
    restrictions: [
      { giverId: 1, receiverId: 2, mutual: true },
      { giverId: 3, receiverId: 4, mutual: false },
      { giverId: 5, receiverId: 6, mutual: true },
    ],
  };
  for (let t = 0; t < 1000; t++) {
    const r = generateAssignment(people, rules);
    assert.ok(r.ok);
    assertValid(people, r.pairs, rules);
    const m = new Map(r.pairs.map((p) => [p.giverId, p.receiverId]));
    assert.notEqual(m.get(1), 2); assert.notEqual(m.get(2), 1);
    assert.notEqual(m.get(3), 4);
    assert.notEqual(m.get(5), 6); assert.notEqual(m.get(6), 5);
  }
});

test('casos muy restringidos con una sola solución se resuelven (vía secuencial)', () => {
  // 1→2→3→4→1 es la única opción posible.
  const people = makePeople(4);
  const restrictions = [];
  const only = { 1: 2, 2: 3, 3: 4, 4: 1 };
  for (const g of [1, 2, 3, 4]) for (const r of [1, 2, 3, 4]) {
    if (g !== r && only[g] !== r) restrictions.push({ giverId: g, receiverId: r, mutual: false });
  }
  const r = generateAssignment(people, { restrictions }, { rejectionAttempts: 0 });
  assert.ok(r.ok);
  assert.equal(r.method, 'secuencial');
  assert.deepEqual(Object.fromEntries(r.pairs.map((p) => [p.giverId, p.receiverId])), { 1: 2, 2: 3, 3: 4, 4: 1 });
});

test('reglas aleatorias: si es factible siempre genera una asignación válida, y si no, lo detecta', () => {
  let feasible = 0; let infeasible = 0;
  for (let t = 0; t < 400; t++) {
    const n = 3 + crypto.randomInt(16);
    const people = makePeople(n);
    const familyOf = Object.fromEntries(people.map((p) => [p.id, 1 + crypto.randomInt(Math.max(2, Math.floor(n / 2)))]));
    const restrictions = [];
    for (let k = crypto.randomInt(n * 2); k > 0; k--) {
      const g = 1 + crypto.randomInt(n); const r = 1 + crypto.randomInt(n);
      if (g !== r) restrictions.push({ giverId: g, receiverId: r, mutual: crypto.randomInt(2) === 1 });
    }
    const rules = { avoidSameFamily: crypto.randomInt(2) === 1, familyOf, restrictions };
    const f = checkFeasibility(people, rules);
    const r = generateAssignment(people, rules, { rejectionAttempts: t % 2 ? 0 : 2000 });
    assert.equal(r.ok, f.possible);
    if (r.ok) { feasible++; assertValid(people, r.pairs, rules); } else { infeasible++; assert.ok(r.problems.length > 0); }
  }
  assert.ok(feasible > 0 && infeasible > 0, `se probaron ambos casos (${feasible}/${infeasible})`);
});

test('familia demasiado grande: se informa que es imposible y por qué', () => {
  const people = makePeople(5);
  const familyOf = { 1: 'A', 2: 'A', 3: 'A', 4: 'B', 5: 'B' };
  const f = checkFeasibility(people, { avoidSameFamily: true, familyOf });
  assert.equal(f.possible, false);
  assert.match(f.problems.join(' '), /familia tiene 3 de 5/);
  assert.equal(generateAssignment(people, { avoidSameFamily: true, familyOf }).ok, false);
});

test('persona sin destinatarios posibles: se explica', () => {
  const people = makePeople(3);
  const rules = { restrictions: [{ giverId: 1, receiverId: 2 }, { giverId: 1, receiverId: 3 }] };
  const f = checkFeasibility(people, rules);
  assert.equal(f.possible, false);
  assert.match(f.problems.join(' '), /Persona 1 no puede regalarle a nadie/);
});

test('el validador detecta duplicados, faltantes, autoasignación y reglas incumplidas', () => {
  const people = makePeople(4);
  const ok = [{ giverId: 1, receiverId: 2 }, { giverId: 2, receiverId: 1 }, { giverId: 3, receiverId: 4 }, { giverId: 4, receiverId: 3 }];
  assert.equal(validateAssignment(people, ok, {}).valid, true);

  const dup = [{ giverId: 1, receiverId: 2 }, { giverId: 2, receiverId: 1 }, { giverId: 3, receiverId: 2 }, { giverId: 4, receiverId: 3 }];
  const vd = validateAssignment(people, dup, {});
  assert.equal(vd.valid, false);
  assert.equal(vd.checks.find((c) => c.key === 'dup').ok, false);

  const missing = ok.slice(0, 3);
  assert.equal(validateAssignment(people, missing, {}).checks.find((c) => c.key === 'complete').ok, false);

  const self = [{ giverId: 1, receiverId: 1 }, { giverId: 2, receiverId: 3 }, { giverId: 3, receiverId: 4 }, { giverId: 4, receiverId: 2 }];
  assert.equal(validateAssignment(people, self, {}).checks.find((c) => c.key === 'self').ok, false);

  const fam = validateAssignment(people, ok, { avoidSameFamily: true, familyOf: { 1: 'X', 2: 'X' } });
  assert.equal(fam.checks.find((c) => c.key === 'rules').ok, false);
});

test('distribución: con 4 personas sin reglas, las 9 asignaciones posibles salen con frecuencia similar', () => {
  const people = makePeople(4);
  const counts = new Map();
  const N = 9000;
  for (let t = 0; t < N; t++) {
    const r = generateAssignment(people, {});
    const k = r.pairs.map((p) => p.receiverId).join('');
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  assert.equal(counts.size, 9, 'existen 9 desarreglos de 4 elementos');
  for (const c of counts.values()) assert.ok(c > N / 9 * 0.8 && c < N / 9 * 1.2, `frecuencia ${c} fuera de rango`);
});
