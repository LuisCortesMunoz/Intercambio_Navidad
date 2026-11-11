'use strict';

// Pruebas de integración: levantan server.js con una base de datos temporal (nunca la real).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PASSWORD = 'clave-de-prueba';
let server; let base; let dataDir;

async function call(fn, args = {}, ip = '10.0.0.1') {
  const res = await fetch(`${base}/api/rpc/${fn}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(args),
  });
  return res.json();
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercambio-test-'));
  const port = 41000 + Math.floor(Math.random() * 2000);
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD: PASSWORD, NODE_ENV: 'test', RENDER: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (/escuchando/.test(String(d))) resolve(); });
    server.stderr.on('data', (d) => { if (/Error/.test(String(d))) reject(new Error(String(d))); });
    server.on('exit', (c) => reject(new Error(`server exit ${c}`)));
  });
  base = `http://127.0.0.1:${port}`;
});

test.after(() => {
  server?.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows puede tardar en liberar */ }
});

test('flujo completo del intercambio', async (t) => {
  // Participantes existentes con opciones de regalo
  const names = ['Ana López', 'Beto López', 'Carla Muñoz', 'Diego Muñoz', 'Elena Ruiz', 'Fer Ruiz', 'Gabi Soto', 'Hugo Soto'];
  const ids = {};
  for (const n of names) ids[n] = (await call('create_person', { p_name: n })).person.id;
  await call('add_gift', { p_person_id: ids['Beto López'], p_name: 'Bufanda', p_description: 'Roja', p_link: '' });

  const { token } = await call('admin_login', { p_password: PASSWORD });
  assert.ok(token);

  await t.test('los participantes no pueden usar funciones de administración', async () => {
    for (const fn of ['admin_assignments', 'admin_draw_generate', 'admin_codes', 'admin_rules', 'admin_draw_set_active']) {
      const r = await call(fn, { p_token: 'falso', p_request_id: 'abcdefgh12' });
      assert.equal(r.status, 401, fn);
    }
    const r = await call('admin_export', { p_token: 'falso', p_password: PASSWORD });
    assert.equal(r.status, 401);
  });

  await t.test('familias y restricciones', async () => {
    const fams = {};
    for (const f of ['López', 'Muñoz', 'Ruiz', 'Soto']) fams[f] = (await call('admin_family_save', { p_token: token, p_name: f })).family.id;
    for (const n of names) {
      const r = await call('admin_set_family', { p_token: token, p_person_id: ids[n], p_family_id: fams[n.split(' ')[1]] });
      assert.equal(r.ok, true);
    }
    assert.equal((await call('admin_set_rule', { p_token: token, p_avoid_same_family: true })).ok, true);
    const rr = await call('admin_restriction_add', { p_token: token, p_giver_id: ids['Ana López'], p_receiver_id: ids['Carla Muñoz'], p_mutual: true });
    assert.ok(rr.restriction);
    const feas = await call('admin_check_feasibility', { p_token: token });
    assert.equal(feas.possible, true);
  });

  let drawId;
  await t.test('generar sorteo es atómico e idempotente', async () => {
    const reqId = 'req-12345678';
    const [a, b] = await Promise.all([
      call('admin_draw_generate', { p_token: token, p_request_id: reqId }),
      call('admin_draw_generate', { p_token: token, p_request_id: reqId }),
    ]);
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    assert.equal(a.drawId, b.drawId, 'el reintento devuelve el mismo sorteo');
    drawId = a.drawId;
    const other = await call('admin_draw_generate', { p_token: token, p_request_id: 'otra-solicitud' });
    assert.equal(other.status, 409, 'no se puede generar un segundo sorteo');
  });

  await t.test('las reglas quedan bloqueadas y no se puede eliminar a un participante', async () => {
    assert.equal((await call('admin_set_rule', { p_token: token, p_avoid_same_family: false })).status, 409);
    assert.equal((await call('admin_family_save', { p_token: token, p_name: 'Nueva' })).status, 409);
    assert.equal((await call('admin_delete_person', { p_token: token, p_id: ids['Ana López'] })).status, 409);
  });

  let rows;
  await t.test('asignaciones válidas: sin duplicados y respetando reglas', async () => {
    const r = await call('admin_assignments', { p_token: token });
    rows = r.rows;
    assert.equal(rows.length, names.length);
    assert.equal(new Set(rows.map((x) => x.receiverId)).size, names.length, 'sin destinatarios repetidos');
    assert.equal(new Set(rows.map((x) => x.giverId)).size, names.length);
    for (const x of rows) {
      assert.notEqual(x.giverId, x.receiverId);
      assert.notEqual(x.giverFamily, x.receiverFamily, 'nadie le regala a su familia');
    }
    const ana = rows.find((x) => x.giverName === 'Ana López');
    const carla = rows.find((x) => x.giverName === 'Carla Muñoz');
    assert.notEqual(ana.receiverName, 'Carla Muñoz');
    assert.notEqual(carla.receiverName, 'Ana López');
    assert.equal(r.validation.valid, true);
    assert.equal(r.stats.pending, names.length);
  });

  const codes = {};
  await t.test('ruleta: código, pausa, giro idempotente y privacidad', async () => {
    for (const c of (await call('admin_codes', { p_token: token })).codes) codes[c.name] = c.code;
    const who = 'Beto López';
    const bad = await call('ruleta_login', { p_person_id: ids[who], p_code: 'XXXXXX' });
    assert.equal(bad.status, 401);
    const wrongPerson = await call('ruleta_login', { p_person_id: ids[who], p_code: codes['Ana López'] });
    assert.equal(wrongPerson.status, 401, 'el código de otra persona no sirve');

    const login = await call('ruleta_login', { p_person_id: ids[who], p_code: codes[who].toLowerCase() });
    assert.ok(login.token);
    const me = await call('ruleta_me', { p_token: login.token });
    assert.equal(me.revealed, false);
    assert.equal(me.recipient, null, 'antes de girar no se envía el destinatario');
    assert.equal(me.wheel.length, names.length - 1);
    assert.ok(!me.wheel.some((p) => p.id === ids[who]), 'la ruleta no incluye a la propia persona');

    const paused = await call('ruleta_spin', { p_token: login.token });
    assert.equal(paused.code, 'paused', 'no se puede girar con la ruleta desactivada');

    assert.equal((await call('admin_draw_set_active', { p_token: token, p_active: true })).active, true);
    const expected = rows.find((x) => x.giverName === who).receiverName;
    const spins = await Promise.all([1, 2, 3].map(() => call('ruleta_spin', { p_token: login.token })));
    for (const s of spins) assert.equal(s.recipient.name, expected, 'siempre el destinatario guardado');
    assert.equal(new Set(spins.map((s) => s.revealedAt)).size, 1, 'la fecha de revelado no cambia');

    const gifts = await call('ruleta_recipient_gifts', { p_token: login.token });
    assert.equal(gifts.recipient.name, expected);
  });

  await t.test('giros simultáneos de todos los participantes', async () => {
    const tokens = await Promise.all(names.map((n, i) => call('ruleta_login', { p_person_id: ids[n], p_code: codes[n] }, `10.0.1.${i}`)));
    const res = await Promise.all(tokens.map((l) => call('ruleta_spin', { p_token: l.token })));
    const received = res.map((r) => r.recipient.name);
    assert.equal(new Set(received).size, names.length, 'cada quien recibe un destinatario distinto');
    for (const [i, n] of names.entries()) assert.equal(received[i], rows.find((x) => x.giverName === n).receiverName);
    const after = await call('admin_assignments', { p_token: token });
    assert.equal(after.stats.revealed, names.length);
    assert.deepEqual(after.rows.map((x) => x.receiverId), rows.map((x) => x.receiverId), 'las asignaciones no cambiaron');
  });

  await t.test('descarga: exige contraseña y entrega un archivo válido', async () => {
    const noPass = await call('admin_export', { p_token: token, p_password: 'mala', p_format: 'xlsx' }, '10.0.9.9');
    assert.equal(noPass.status, 401);
    const x = await call('admin_export', { p_token: token, p_password: PASSWORD, p_format: 'xlsx' });
    assert.equal(x.valid, true);
    const buf = Buffer.from(x.data, 'base64');
    assert.equal(buf.subarray(0, 2).toString(), 'PK', 'es un archivo .xlsx (zip)');
    fs.writeFileSync(path.join(dataDir, 'prueba.xlsx'), buf);
    const c = await call('admin_export', { p_token: token, p_password: PASSWORD, p_format: 'csv' });
    const csv = Buffer.from(c.data, 'base64').toString('utf8');
    assert.match(csv, /Participante,Familia,Le toca regalar a/);
    assert.equal(csv.trim().split('\r\n').length, names.length + 1);
  });

  await t.test('reiniciar exige contraseña, confirmación y el sorteo correcto', async () => {
    assert.equal((await call('admin_draw_reset', { p_token: token, p_password: 'mala', p_draw_id: drawId, p_confirm: 'REINICIAR' }, '10.0.8.8')).status, 401);
    assert.equal((await call('admin_draw_reset', { p_token: token, p_password: PASSWORD, p_draw_id: drawId, p_confirm: 'no' })).status, 400);
    assert.equal((await call('admin_draw_reset', { p_token: token, p_password: PASSWORD, p_draw_id: drawId + 99, p_confirm: 'REINICIAR' })).status, 409);
    assert.equal((await call('admin_draw_reset', { p_token: token, p_password: PASSWORD, p_draw_id: drawId, p_confirm: 'REINICIAR' })).ok, true);
    const again = await call('admin_draw_reset', { p_token: token, p_password: PASSWORD, p_draw_id: drawId, p_confirm: 'REINICIAR' });
    assert.equal(again.alreadyReset, true, 'repetir el reinicio no hace nada');
    const r = await call('admin_assignments', { p_token: token });
    assert.equal(r.draw, null);
    assert.ok(r.log.some((l) => l.action === 'intercambio_reiniciado'), 'queda registrado');
    // Las opciones de regalo siguen intactas
    const beto = await call('get_person', { p_id: ids['Beto López'] });
    assert.equal(beto.person.gifts.length, 1);
  });

  await t.test('reglas imposibles: se informa al dueño', async () => {
    // Todos en la misma familia
    const fam = (await call('admin_family_save', { p_token: token, p_name: 'Todos' })).family.id;
    for (const n of names) await call('admin_set_family', { p_token: token, p_person_id: ids[n], p_family_id: fam });
    const r = await call('admin_draw_generate', { p_token: token, p_request_id: 'req-imposible' });
    assert.equal(r.status, 422);
    assert.ok(r.problems.length > 0);
    assert.equal((await call('admin_assignments', { p_token: token })).draw, null, 'no se guardó nada parcial');
  });
});
