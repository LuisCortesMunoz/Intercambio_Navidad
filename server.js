'use strict';

/*
 * Intercambio Navideño — servidor
 * Node >= 22.13 (usa node:sqlite integrado; sin dependencias externas).
 *
 * Variables de entorno:
 *   PORT                 Puerto (Render lo define solo).
 *   DATA_DIR             Carpeta donde se guarda la base de datos (en Render: el disco persistente, ej. /var/data).
 *   ADMIN_PASSWORD       Contraseña del dueño (variable secreta; nunca va en el código).
 *   ADMIN_PASSWORD_HASH  Alternativa a ADMIN_PASSWORD: hash "scrypt$salt$hash" (ver scripts/hash-password.js).
 *   ZONA_HORARIA         Zona horaria para las fechas del archivo descargado (por defecto America/Mexico_City).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const sorteo = require('./lib/sorteo');
const { buildXlsx, buildCsv } = require('./lib/xlsx');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 horas
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

/* ------------------------------------------------------------------ */
/* Contraseña del dueño (solo en memoria del servidor, cifrada)        */
/* ------------------------------------------------------------------ */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH
  || (process.env.ADMIN_PASSWORD ? hashPassword(process.env.ADMIN_PASSWORD) : '');
delete process.env.ADMIN_PASSWORD;

if (!ADMIN_HASH) {
  console.warn('⚠️  Falta la variable ADMIN_PASSWORD: el acceso de "Dueño" estará deshabilitado.');
}

function verifyPassword(password) {
  const parts = ADMIN_HASH.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(parts[1], 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/* ------------------------------------------------------------------ */
/* Base de datos                                                       */
/* ------------------------------------------------------------------ */

fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'intercambio.db');
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS people (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    name_key   TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS gifts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_gifts_person ON gifts(person_id);
`);

// Migración: columna para el enlace de cada opción (bases creadas antes de esta versión).
if (!db.prepare('PRAGMA table_info(gifts)').all().some((c) => c.name === 'link')) {
  db.exec("ALTER TABLE gifts ADD COLUMN link TEXT NOT NULL DEFAULT ''");
}

const q = {
  allPeople: db.prepare(`
    SELECT p.id, p.name, p.name_key AS key, COUNT(g.id) AS giftCount
    FROM people p LEFT JOIN gifts g ON g.person_id = p.id
    GROUP BY p.id ORDER BY p.name COLLATE NOCASE`),
  personById: db.prepare('SELECT id, name FROM people WHERE id = ?'),
  personByKey: db.prepare('SELECT id, name FROM people WHERE name_key = ?'),
  insertPerson: db.prepare('INSERT INTO people (name, name_key) VALUES (?, ?)'),
  deletePerson: db.prepare('DELETE FROM people WHERE id = ?'),
  giftsByPerson: db.prepare(
    'SELECT id, name, description, link, created_at AS createdAt FROM gifts WHERE person_id = ? ORDER BY id'),
  allGifts: db.prepare(
    'SELECT id, person_id AS personId, name, description, link, created_at AS createdAt FROM gifts ORDER BY id'),
  insertGift: db.prepare('INSERT INTO gifts (person_id, name, description, link) VALUES (?, ?, ?, ?)'),
  updateGift: db.prepare('UPDATE gifts SET name = ?, description = ?, link = ? WHERE id = ? AND person_id = ?'),
  giftByPersonAndName: db.prepare(
    'SELECT id FROM gifts WHERE person_id = ? AND lower(name) = lower(?) AND id <> ?'),
  deleteGift: db.prepare('DELETE FROM gifts WHERE id = ?'),
};

/* ------------------------------------------------------------------ */
/* Sorteo: tablas nuevas (no modifican people ni gifts)                */
/* ------------------------------------------------------------------ */

db.exec(`
  CREATE TABLE IF NOT EXISTS families (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    name_key   TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS family_members (
    person_id INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
    family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS restrictions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    giver_id    INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    mutual      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    CHECK (giver_id <> receiver_id),
    UNIQUE (giver_id, receiver_id)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- Solo puede existir un sorteo a la vez (slot siempre vale 1 y es único).
  CREATE TABLE IF NOT EXISTS draws (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slot         INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (slot = 1),
    request_id   TEXT NOT NULL,
    participants TEXT NOT NULL,
    active       INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  -- La base de datos misma impide duplicados y autoasignaciones.
  CREATE TABLE IF NOT EXISTS assignments (
    draw_id     INTEGER NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
    giver_id    INTEGER NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
    receiver_id INTEGER NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
    revealed_at TEXT,
    PRIMARY KEY (draw_id, giver_id),
    UNIQUE (draw_id, receiver_id),
    CHECK (giver_id <> receiver_id)
  );
  CREATE TABLE IF NOT EXISTS access_codes (
    person_id  INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
    code       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE TABLE IF NOT EXISTS exchange_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    ip         TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
`);

const qs = {
  peopleBasic: db.prepare('SELECT id, name FROM people ORDER BY name COLLATE NOCASE'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),

  families: db.prepare(`
    SELECT f.id, f.name, COUNT(m.person_id) AS members
    FROM families f LEFT JOIN family_members m ON m.family_id = f.id
    GROUP BY f.id ORDER BY f.name COLLATE NOCASE`),
  familyById: db.prepare('SELECT id, name FROM families WHERE id = ?'),
  familyByKey: db.prepare('SELECT id, name FROM families WHERE name_key = ?'),
  insertFamily: db.prepare('INSERT INTO families (name, name_key) VALUES (?, ?)'),
  renameFamily: db.prepare('UPDATE families SET name = ?, name_key = ? WHERE id = ?'),
  deleteFamily: db.prepare('DELETE FROM families WHERE id = ?'),
  members: db.prepare('SELECT person_id AS personId, family_id AS familyId FROM family_members'),
  setMember: db.prepare(`INSERT INTO family_members (person_id, family_id) VALUES (?, ?)
    ON CONFLICT(person_id) DO UPDATE SET family_id = excluded.family_id`),
  clearMember: db.prepare('DELETE FROM family_members WHERE person_id = ?'),

  restrictions: db.prepare(
    'SELECT id, giver_id AS giverId, receiver_id AS receiverId, mutual FROM restrictions ORDER BY id'),
  restrictionBetween: db.prepare(
    'SELECT id FROM restrictions WHERE (giver_id = ? AND receiver_id = ?) OR (giver_id = ? AND receiver_id = ?)'),
  insertRestriction: db.prepare('INSERT INTO restrictions (giver_id, receiver_id, mutual) VALUES (?, ?, ?)'),
  deleteRestriction: db.prepare('DELETE FROM restrictions WHERE id = ?'),

  currentDraw: db.prepare(
    'SELECT id, request_id AS requestId, participants, active, created_at AS createdAt FROM draws WHERE slot = 1'),
  insertDraw: db.prepare('INSERT INTO draws (request_id, participants) VALUES (?, ?)'),
  setDrawActive: db.prepare('UPDATE draws SET active = ? WHERE id = ?'),
  deleteDraw: db.prepare('DELETE FROM draws WHERE id = ?'),
  insertAssignment: db.prepare('INSERT INTO assignments (draw_id, giver_id, receiver_id) VALUES (?, ?, ?)'),
  deleteAssignments: db.prepare('DELETE FROM assignments WHERE draw_id = ?'),
  pairs: db.prepare('SELECT giver_id AS giverId, receiver_id AS receiverId FROM assignments WHERE draw_id = ?'),
  assignmentOf: db.prepare(`
    SELECT a.receiver_id AS receiverId, p.name AS receiverName, a.revealed_at AS revealedAt
    FROM assignments a JOIN people p ON p.id = a.receiver_id
    WHERE a.draw_id = ? AND a.giver_id = ?`),
  reveal: db.prepare('UPDATE assignments SET revealed_at = ? WHERE draw_id = ? AND giver_id = ? AND revealed_at IS NULL'),
  assignmentRows: db.prepare(`
    SELECT a.giver_id AS giverId, g.name AS giverName, fg.name AS giverFamily,
           a.receiver_id AS receiverId, r.name AS receiverName, fr.name AS receiverFamily,
           a.revealed_at AS revealedAt
    FROM assignments a
    JOIN people g ON g.id = a.giver_id
    JOIN people r ON r.id = a.receiver_id
    LEFT JOIN family_members mg ON mg.person_id = a.giver_id LEFT JOIN families fg ON fg.id = mg.family_id
    LEFT JOIN family_members mr ON mr.person_id = a.receiver_id LEFT JOIN families fr ON fr.id = mr.family_id
    WHERE a.draw_id = ? ORDER BY g.name COLLATE NOCASE`),

  codes: db.prepare(`
    SELECT p.id, p.name, c.code FROM people p LEFT JOIN access_codes c ON c.person_id = p.id
    ORDER BY p.name COLLATE NOCASE`),
  codeOf: db.prepare('SELECT code FROM access_codes WHERE person_id = ?'),
  codeExists: db.prepare('SELECT 1 FROM access_codes WHERE code = ?'),
  setCode: db.prepare(`INSERT INTO access_codes (person_id, code) VALUES (?, ?)
    ON CONFLICT(person_id) DO UPDATE SET code = excluded.code, created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`),

  log: db.prepare('INSERT INTO exchange_log (action, detail, ip) VALUES (?, ?, ?)'),
  recentLog: db.prepare('SELECT action, detail, created_at AS createdAt FROM exchange_log ORDER BY id DESC LIMIT 40'),
};

/** Ejecuta fn dentro de una transacción: o se guarda todo, o nada. */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ya revertida */ }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

/** Quita acentos, pasa a minúsculas y colapsa espacios: "José  PÉREZ" -> "jose perez" */
function normalize(str) {
  return String(str ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** "josé  luis PÉREZ" -> "José Luis Pérez" (respeta "McDonald", "O'Connor"). */
function tidyName(str) {
  const fix = (p) => {
    const lower = p.toLocaleLowerCase('es');
    const mixed = p !== lower && p !== p.toLocaleUpperCase('es');
    return mixed ? p.charAt(0).toLocaleUpperCase('es') + p.slice(1)
      : lower.charAt(0).toLocaleUpperCase('es') + lower.slice(1);
  };
  return String(str ?? '').replace(/\s+/g, ' ').trim()
    .split(' ').map((w) => w.split('-').map(fix).join('-')).join(' ');
}

function cleanText(str) {
  return String(str ?? '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').trim();
}

/** Acepta "amazon.com/x" o "https://…"; devuelve { link } normalizado o { error }. */
function normalizeLink(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return { link: '' };
  if (s.length > 500) return { error: 'El enlace es muy largo (máx. 500 caracteres).' };
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw new Error();
    return { link: u.href };
  } catch {
    return { error: 'El enlace no es válido. Ejemplo: https://www.tienda.com/producto' };
  }
}

/** Valida los campos de una opción de regalo. */
function validateGift({ p_name, p_description, p_link }) {
  const name = cleanText(p_name).replace(/\n/g, ' ');
  const description = cleanText(p_description);
  if (!name && !description) return { error: 'Falta el nombre del regalo y la descripción.' };
  if (!name) return { error: 'Falta el nombre del regalo.' };
  if (!description) return { error: 'Falta la descripción.' };
  if (name.length > 100) return { error: 'El nombre del regalo es muy largo (máx. 100 caracteres).' };
  if (description.length > 1500) return { error: 'La descripción es muy larga (máx. 1500 caracteres).' };
  const l = normalizeLink(p_link);
  if (l.error) return { error: l.error };
  return { name, description, link: l.link };
}

const NAME_WORD = /^[\p{L}][\p{L}'’.-]*$/u;
const fail = (status, error, extra = {}) => ({ status, error, ...extra });
const asId = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/* ------------------------------------------------------------------ */
/* Sesiones del dueño y límite de intentos                             */
/* ------------------------------------------------------------------ */

const sessions = new Map(); // sha256(token) -> expiresAt
const tokenKey = (t) => crypto.createHash('sha256').update(String(t ?? '')).digest('hex');

function isAdmin(token) {
  if (!token) return false;
  const k = tokenKey(token);
  const exp = sessions.get(k);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(k); return false; }
  return true;
}

const loginAttempts = new Map(); // ip -> { fails, until }
function loginWaitMinutes(ip) {
  const a = loginAttempts.get(ip);
  return a && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 60000) : 0;
}
function registerFail(ip) {
  const a = loginAttempts.get(ip) || { fails: 0, until: 0 };
  a.fails += 1;
  if (a.fails >= 5) { a.until = Date.now() + 15 * 60 * 1000; a.fails = 0; }
  loginAttempts.set(ip, a);
}

/** Vuelve a pedir la contraseña del dueño (descargas y reinicio). Devuelve un error o null. */
function recheckPassword(password, ip) {
  const wait = loginWaitMinutes(ip);
  if (wait) return fail(429, `Demasiados intentos. Intenta de nuevo en ${wait} min.`);
  if (!ADMIN_HASH) return fail(503, 'El acceso de dueño no está configurado en el servidor.');
  if (typeof password !== 'string' || !password || password.length > 200 || !verifyPassword(password)) {
    registerFail(ip);
    return fail(401, 'Contraseña incorrecta.', { badPassword: true });
  }
  loginAttempts.delete(ip);
  return null;
}

/* ------------------------------------------------------------------ */
/* Sesiones de participantes (ruleta) y códigos de acceso              */
/* ------------------------------------------------------------------ */

const PLAYER_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas
const playerSessions = new Map(); // sha256(token) -> { personId, exp }
const codeAttempts = new Map();   // "ip|persona" e "ip" -> { fails, until }
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I/L

function playerOf(token) {
  if (!token) return null;
  const k = tokenKey(token);
  const s = playerSessions.get(k);
  if (!s) return null;
  if (s.exp < Date.now()) { playerSessions.delete(k); return null; }
  return s;
}

function codeWait(keys) {
  const now = Date.now();
  const until = Math.max(0, ...keys.map((k) => codeAttempts.get(k)?.until || 0));
  return until > now ? Math.ceil((until - now) / 60000) : 0;
}
function codeFail(key, max, lockMs) {
  const a = codeAttempts.get(key) || { fails: 0, until: 0 };
  a.fails += 1;
  if (a.fails >= max) { a.until = Date.now() + lockMs; a.fails = 0; }
  codeAttempts.set(key, a);
}

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!qs.codeExists.get(c)) return c;
  }
}
function ensureCode(personId) {
  const row = qs.codeOf.get(personId);
  if (row) return row.code;
  const code = newCode();
  qs.setCode.run(personId, code);
  return code;
}
const cleanCode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);

function sameCode(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of sessions) if (exp < now) sessions.delete(k);
  for (const [ip, a] of loginAttempts) if (a.until < now && a.fails === 0) loginAttempts.delete(ip);
  for (const [k, s] of playerSessions) if (s.exp < now) playerSessions.delete(k);
  for (const [k, a] of codeAttempts) if (a.until < now) codeAttempts.delete(k);
}, 10 * 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* Sorteo: utilidades                                                  */
/* ------------------------------------------------------------------ */

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const logEvent = (action, detail, ip = '') => qs.log.run(action, String(detail || ''), String(ip || ''));

function getDraw() {
  const d = qs.currentDraw.get();
  if (!d) return null;
  return { ...d, active: !!d.active, participantIds: JSON.parse(d.participants) };
}

/** Participantes del sorteo con su nombre actual. */
function drawPeople(draw) {
  return draw.participantIds.map((id) => ({ id, name: q.personById.get(id)?.name || `(persona eliminada #${id})` }));
}

function loadRules() {
  const familyOf = new Map(qs.members.all().map((m) => [m.personId, m.familyId]));
  return {
    avoidSameFamily: qs.getSetting.get('avoid_same_family')?.value === '1',
    familyOf,
    restrictions: qs.restrictions.all().map((r) => ({ ...r, mutual: !!r.mutual })),
  };
}

/** Valida el sorteo guardado contra los participantes y las reglas (bloqueadas) actuales. */
function validateDraw(draw) {
  const people = drawPeople(draw);
  const v = sorteo.validateAssignment(people, qs.pairs.all(draw.id), loadRules());
  const inDraw = new Set(draw.participantIds);
  const missingPeople = people.filter((p) => !q.personById.get(p.id));
  if (missingPeople.length) {
    v.valid = false;
    v.errors.unshift(...missingPeople.map((p) => `${p.name} ya no existe en la lista de participantes.`));
  }
  const late = q.allPeople.all().filter((p) => !inDraw.has(p.id)).map((p) => p.name);
  const warnings = late.length
    ? [`${late.join(', ')} se ${late.length === 1 ? 'registró' : 'registraron'} después del sorteo y no ${late.length === 1 ? 'participa' : 'participan'}. Si debe${late.length === 1 ? '' : 'n'} participar, reinicia el intercambio.`]
    : [];
  return { ...v, warnings };
}

const LOCKED = fail(409, 'Las reglas están bloqueadas porque ya hay un sorteo generado. Para cambiarlas, reinicia el intercambio.');
const NO_PLAYER = fail(401, 'Tu sesión terminó. Vuelve a escribir tu código.', { code: 'session' });

function formatLocal(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('es-MX', {
      timeZone: process.env.ZONA_HORARIA || 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'short',
    });
  } catch { return iso; }
}

/* ------------------------------------------------------------------ */
/* Funciones de la API  (POST /api/rpc/<nombre>)                       */
/* ------------------------------------------------------------------ */

const ADMIN_EXPIRED = fail(401, 'Tu sesión de dueño expiró. Vuelve a ingresar.');

const RPC = {
  search_people({ p_query }) {
    const terms = normalize(p_query).split(' ').filter(Boolean);
    return q.allPeople.all()
      .filter((p) => terms.every((t) => p.key.includes(t)))
      .map(({ id, name, giftCount }) => ({ id, name, giftCount }));
  },

  get_person({ p_id }) {
    const person = q.personById.get(asId(p_id));
    if (!person) return fail(404, 'Esta persona ya no existe.');
    return { person: { ...person, gifts: q.giftsByPerson.all(person.id) } };
  },

  create_person({ p_name }) {
    const name = tidyName(p_name);
    if (!name) return fail(400, 'Escribe tu nombre y primer apellido.');
    if (name.length > 80) return fail(400, 'El nombre es demasiado largo (máx. 80 caracteres).');
    const words = name.split(' ');
    if (words.length < 2) return fail(400, 'Debes escribir al menos tu nombre y tu primer apellido.');
    if (!words.every((w) => NAME_WORD.test(w))) return fail(400, 'El nombre solo puede contener letras, espacios, guiones o apóstrofes.');
    if (words.some((w) => w.replace(/[^\p{L}]/gu, '').length < 2)) return fail(400, 'Cada nombre y apellido debe tener al menos 2 letras.');
    const key = normalize(name);
    const existing = q.personByKey.get(key);
    if (existing) {
      return fail(409, `"${existing.name}" ya está registrado. Selecciona ese perfil para agregar opciones.`, { person: existing });
    }
    const info = q.insertPerson.run(name, key);
    return { person: { id: Number(info.lastInsertRowid), name, giftCount: 0 } };
  },

  add_gift(args) {
    const person = q.personById.get(asId(args.p_person_id));
    if (!person) return fail(404, 'Esta persona ya no existe.');
    const v = validateGift(args);
    if (v.error) return fail(400, v.error);
    if (q.giftByPersonAndName.get(person.id, v.name, 0)) return fail(409, `Ya registraste una opción llamada "${v.name}".`);
    const info = q.insertGift.run(person.id, v.name, v.description, v.link);
    return { gift: { id: Number(info.lastInsertRowid), name: v.name, description: v.description, link: v.link } };
  },

  update_gift(args) {
    const person = q.personById.get(asId(args.p_person_id));
    if (!person) return fail(404, 'Esta persona ya no existe.');
    const giftId = asId(args.p_gift_id);
    const v = validateGift(args);
    if (v.error) return fail(400, v.error);
    if (q.giftByPersonAndName.get(person.id, v.name, giftId)) return fail(409, `Ya tienes otra opción llamada "${v.name}".`);
    const info = q.updateGift.run(v.name, v.description, v.link, giftId, person.id);
    if (!info.changes) return fail(404, 'Esta opción ya no existe.');
    return { gift: { id: giftId, name: v.name, description: v.description, link: v.link } };
  },

  admin_login({ p_password }, ctx) {
    const wait = loginWaitMinutes(ctx.ip);
    if (wait) return fail(429, `Demasiados intentos. Intenta de nuevo en ${wait} min.`);
    if (!ADMIN_HASH) return fail(503, 'El acceso de dueño no está configurado en el servidor.');
    if (typeof p_password !== 'string' || !p_password || p_password.length > 200 || !verifyPassword(p_password)) {
      registerFail(ctx.ip);
      return fail(401, 'Contraseña incorrecta.');
    }
    loginAttempts.delete(ctx.ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(tokenKey(token), Date.now() + SESSION_TTL_MS);
    return { token };
  },

  admin_logout({ p_token }) {
    sessions.delete(tokenKey(p_token));
    return { ok: true };
  },

  admin_check({ p_token }) {
    return { admin: isAdmin(p_token) };
  },

  admin_list({ p_token }) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    const gifts = q.allGifts.all();
    return {
      people: q.allPeople.all().map(({ id, name }) => ({
        id, name, gifts: gifts.filter((g) => g.personId === id).map(({ personId, ...g }) => g),
      })),
    };
  },

  admin_delete_person({ p_token, p_id }) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    const draw = getDraw();
    if (draw?.participantIds.includes(asId(p_id))) {
      const name = q.personById.get(asId(p_id))?.name || 'esta persona';
      return fail(409, `No se puede eliminar a ${name} porque participa en el sorteo actual. Primero reinicia el intercambio.`);
    }
    return q.deletePerson.run(asId(p_id)).changes ? { ok: true } : fail(404, 'La persona ya no existe.');
  },

  admin_delete_gift({ p_token, p_id }) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    return q.deleteGift.run(asId(p_id)).changes ? { ok: true } : fail(404, 'La opción ya no existe.');
  },

  /* ---------------- Reglas del intercambio (dueño) ---------------- */

  admin_rules({ p_token }) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    const rules = loadRules();
    return {
      locked: !!getDraw(),
      avoidSameFamily: rules.avoidSameFamily,
      families: qs.families.all(),
      people: qs.peopleBasic.all().map((p) => ({ ...p, familyId: rules.familyOf.get(p.id) ?? null })),
      restrictions: rules.restrictions,
    };
  },

  admin_family_save({ p_token, p_id, p_name }) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    if (getDraw()) return LOCKED;
    const name = tidyName(p_name);
    if (!name) return fail(400, 'Escribe el nombre de la familia.');
    if (name.length > 60) return fail(400, 'El nombre es muy largo (máx. 60 caracteres).');
    const key = normalize(name);
    const id = asId(p_id);
    const same = qs.familyByKey.get(key);
    if (same && same.id !== id) return fail(409, `Ya existe la familia "${same.name}".`);
    if (id) {
      if (!qs.renameFamily.run(name, key, id).changes) return fail(404, 'La familia ya no existe.');
      return { family: { id, name } };
    }
    const info = qs.insertFamily.run(name, key);
    return { family: { id: Number(info.lastInsertRowid), name } };
  },

  admin_family_delete({ p_token, p_id }) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    if (getDraw()) return LOCKED;
    return qs.deleteFamily.run(asId(p_id)).changes ? { ok: true } : fail(404, 'La familia ya no existe.');
  },

  admin_set_family({ p_token, p_person_id, p_family_id }) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    if (getDraw()) return LOCKED;
    const person = q.personById.get(asId(p_person_id));
    if (!person) return fail(404, 'Esta persona ya no existe.');
    const familyId = asId(p_family_id);
    if (!familyId) { qs.clearMember.run(person.id); return { ok: true }; }
    if (!qs.familyById.get(familyId)) return fail(404, 'La familia ya no existe.');
    qs.setMember.run(person.id, familyId);
    return { ok: true };
  },

  admin_set_rule({ p_token, p_avoid_same_family }) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    if (getDraw()) return LOCKED;
    qs.setSetting.run('avoid_same_family', p_avoid_same_family ? '1' : '0');
    return { ok: true, avoidSameFamily: !!p_avoid_same_family };
  },

  admin_restriction_add({ p_token, p_giver_id, p_receiver_id, p_mutual }) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    if (getDraw()) return LOCKED;
    const g = q.personById.get(asId(p_giver_id));
    const r = q.personById.get(asId(p_receiver_id));
    if (!g || !r) return fail(400, 'Elige a las dos personas de la restricción.');
    if (g.id === r.id) return fail(400, 'Elige a dos personas distintas.');
    if (qs.restrictionBetween.get(g.id, r.id, r.id, g.id)) {
      return fail(409, `Ya existe una restricción entre ${g.name} y ${r.name}. Elimínala si quieres cambiarla.`);
    }
    const info = qs.insertRestriction.run(g.id, r.id, p_mutual ? 1 : 0);
    return { restriction: { id: Number(info.lastInsertRowid), giverId: g.id, receiverId: r.id, mutual: !!p_mutual } };
  },

  admin_restriction_delete({ p_token, p_id }) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    if (getDraw()) return LOCKED;
    return qs.deleteRestriction.run(asId(p_id)).changes ? { ok: true } : fail(404, 'La restricción ya no existe.');
  },

  admin_check_feasibility({ p_token }) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    return sorteo.checkFeasibility(qs.peopleBasic.all(), loadRules());
  },

  /* ---------------- Sorteo (dueño) ---------------- */

  admin_draw_generate({ p_token, p_request_id }, ctx) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    const requestId = typeof p_request_id === 'string' && /^[\w-]{8,64}$/.test(p_request_id) ? p_request_id : '';
    if (!requestId) return fail(400, 'Solicitud inválida.');
    const existing = getDraw();
    if (existing) {
      // Reintento de la misma solicitud (p. ej. se cortó la conexión): no genera nada nuevo.
      if (existing.requestId === requestId) return { ok: true, drawId: existing.id, participants: existing.participantIds.length, repeated: true };
      return fail(409, 'Ya existe un sorteo generado. Para hacer otro, primero reinicia el intercambio.');
    }
    const people = qs.peopleBasic.all();
    const gen = sorteo.generateAssignment(people, loadRules());
    if (!gen.ok) {
      return fail(422, 'No es posible hacer el sorteo con las reglas actuales. Ajusta las restricciones e intenta de nuevo.', { problems: gen.problems });
    }
    const drawId = tx(() => {
      const info = qs.insertDraw.run(requestId, JSON.stringify(people.map((p) => p.id)));
      const id = Number(info.lastInsertRowid);
      for (const { giverId, receiverId } of gen.pairs) qs.insertAssignment.run(id, giverId, receiverId);
      for (const p of people) ensureCode(p.id);
      logEvent('sorteo_generado', `Sorteo #${id}: ${people.length} participantes.`, ctx.ip);
      return id;
    });
    return { ok: true, drawId, participants: people.length };
  },

  admin_draw_validate({ p_token }) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    const draw = getDraw();
    if (!draw) return fail(409, 'Todavía no hay un sorteo generado.');
    return { validation: validateDraw(draw) };
  },

  admin_draw_set_active({ p_token, p_active }, ctx) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    const draw = getDraw();
    if (!draw) return fail(409, 'Primero genera el sorteo.');
    const active = !!p_active;
    if (active) {
      const v = validateDraw(draw);
      if (!v.valid) return fail(409, 'El sorteo tiene inconsistencias y no se puede activar la ruleta.', { validation: v });
    }
    if (draw.active !== active) {
      qs.setDrawActive.run(active ? 1 : 0, draw.id);
      logEvent(active ? 'ruleta_activada' : 'ruleta_desactivada', `Sorteo #${draw.id}`, ctx.ip);
    }
    return { ok: true, active };
  },

  admin_draw_reset({ p_token, p_password, p_draw_id, p_confirm }, ctx) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    const bad = recheckPassword(p_password, ctx.ip);
    if (bad) return bad;
    if (String(p_confirm || '').trim().toUpperCase() !== 'REINICIAR') return fail(400, 'Escribe REINICIAR para confirmar.');
    const draw = getDraw();
    if (!draw) return { ok: true, alreadyReset: true };
    if (asId(p_draw_id) !== draw.id) return fail(409, 'El sorteo cambió mientras tanto. Actualiza la página e intenta de nuevo.');
    tx(() => {
      const rows = qs.assignmentRows.all(draw.id);
      const revealed = rows.filter((r) => r.revealedAt).length;
      qs.deleteAssignments.run(draw.id);
      qs.deleteDraw.run(draw.id);
      logEvent('intercambio_reiniciado', `Sorteo #${draw.id} eliminado: ${rows.length} asignaciones, ${revealed} ya reveladas.`, ctx.ip);
    });
    return { ok: true };
  },

  admin_assignments({ p_token }) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    const draw = getDraw();
    const log = qs.recentLog.all();
    if (!draw) return { draw: null, rows: [], stats: { participants: q.allPeople.all().length, assignments: 0, revealed: 0, pending: 0 }, validation: null, log };
    const rows = qs.assignmentRows.all(draw.id);
    const revealed = rows.filter((r) => r.revealedAt).length;
    return {
      draw: { id: draw.id, active: draw.active, createdAt: draw.createdAt },
      rows,
      stats: { participants: draw.participantIds.length, assignments: rows.length, revealed, pending: rows.length - revealed },
      validation: validateDraw(draw),
      log,
    };
  },

  admin_codes({ p_token }) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    tx(() => { for (const p of qs.peopleBasic.all()) ensureCode(p.id); });
    const inDraw = new Set(getDraw()?.participantIds || []);
    return { codes: qs.codes.all().map((c) => ({ ...c, inDraw: inDraw.has(c.id) })) };
  },

  admin_code_regenerate({ p_token, p_person_id }, ctx) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    const person = q.personById.get(asId(p_person_id));
    if (!person) return fail(404, 'Esta persona ya no existe.');
    const code = newCode();
    qs.setCode.run(person.id, code);
    // Cierra las sesiones abiertas con el código anterior.
    for (const [k, s] of playerSessions) if (s.personId === person.id) playerSessions.delete(k);
    logEvent('codigo_regenerado', person.name, ctx.ip);
    return { code };
  },

  admin_export({ p_token, p_password, p_format }, ctx) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    const bad = recheckPassword(p_password, ctx.ip);
    if (bad) return bad;
    const draw = getDraw();
    if (!draw) return fail(409, 'Todavía no hay un sorteo generado.');
    const v = validateDraw(draw);
    const rows = qs.assignmentRows.all(draw.id);
    const header = ['Participante', 'Familia', 'Le toca regalar a', 'Familia del destinatario', 'Estado', 'Fecha y hora de revelado'];
    const data = rows.map((r) => [r.giverName, r.giverFamily || '—', r.receiverName, r.receiverFamily || '—',
      r.revealedAt ? 'Revelado' : 'Pendiente', formatLocal(r.revealedAt)]);
    const status = v.valid ? 'SORTEO VÁLIDO ✔' : 'SORTEO NO VÁLIDO — revisar inconsistencias';
    const day = nowIso().slice(0, 10);
    const suffix = v.valid ? '' : '_NO-VALIDO';
    const format = p_format === 'csv' ? 'csv' : 'xlsx';
    let file;
    if (format === 'csv') {
      file = buildCsv([
        ...(v.valid ? [] : [[`⚠️ ${status}`], ...v.errors.map((e) => [e]), []]),
        header, ...data,
      ]);
    } else {
      const rules = loadRules();
      file = buildXlsx([
        {
          name: 'Asignaciones',
          columns: [{ header: header[0], width: 28 }, { header: header[1], width: 20 }, { header: header[2], width: 28 },
            { header: header[3], width: 24 }, { header: header[4], width: 12 }, { header: header[5], width: 24 }],
          rows: data,
        },
        {
          name: 'Resumen',
          columns: [{ header: 'Dato', width: 34 }, { header: 'Valor', width: 70 }],
          rows: [
            ['Estado de validación', status],
            ...v.checks.map((c) => [c.label, c.ok ? 'Sí ✔' : 'NO ✘']),
            ...v.errors.map((e) => ['Inconsistencia', e]),
            ...v.warnings.map((w) => ['Aviso', w]),
            ['Sorteo generado', formatLocal(draw.createdAt)],
            ['Total de participantes', draw.participantIds.length],
            ['Ya revelaron', rows.filter((r) => r.revealedAt).length],
            ['Pendientes', rows.filter((r) => !r.revealedAt).length],
            ['Evitar regalos en la misma familia', rules.avoidSameFamily ? 'Sí' : 'No'],
            ['Restricciones particulares', rules.restrictions.length],
            ['Archivo generado', formatLocal(nowIso())],
          ],
        },
      ]);
    }
    logEvent('descarga', `Formato ${format.toUpperCase()}${v.valid ? '' : ' (NO VÁLIDO)'}`, ctx.ip);
    return {
      filename: `asignaciones-intercambio-${day}${suffix}.${format}`,
      mime: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: file.toString('base64'),
      valid: v.valid,
      errors: v.errors,
    };
  },

  /* ---------------- Ruleta (participantes) ---------------- */

  ruleta_status() {
    const draw = getDraw();
    if (!draw) return { hasDraw: false, active: false, participants: [] };
    const participants = drawPeople(draw).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    return { hasDraw: true, active: draw.active, participants };
  },

  ruleta_login({ p_person_id, p_code }, ctx) {
    const personId = asId(p_person_id);
    const keyPerson = `${ctx.ip}|${personId}`;
    const wait = codeWait([keyPerson, ctx.ip]);
    if (wait) return fail(429, `Demasiados intentos. Intenta de nuevo en ${wait} min.`);
    const draw = getDraw();
    if (!draw) return fail(409, 'La ruleta todavía no está disponible.');
    if (!draw.participantIds.includes(personId)) return fail(404, 'Esta persona no participa en el sorteo.');
    const code = cleanCode(p_code);
    const stored = qs.codeOf.get(personId)?.code;
    if (!code || !stored || !sameCode(code, stored)) {
      codeFail(keyPerson, 6, 10 * 60 * 1000);
      codeFail(ctx.ip, 40, 15 * 60 * 1000);
      return fail(401, 'El código no es correcto. Revisa que sea el tuyo.');
    }
    codeAttempts.delete(keyPerson);
    const token = crypto.randomBytes(32).toString('hex');
    playerSessions.set(tokenKey(token), { personId, exp: Date.now() + PLAYER_TTL_MS });
    return { token, person: q.personById.get(personId) };
  },

  ruleta_logout({ p_token }) {
    playerSessions.delete(tokenKey(p_token));
    return { ok: true };
  },

  ruleta_me({ p_token }) {
    const s = playerOf(p_token);
    if (!s) return NO_PLAYER;
    const draw = getDraw();
    if (!draw || !draw.participantIds.includes(s.personId)) {
      return fail(409, 'Ya no hay un sorteo disponible para ti. Pregúntale al dueño del intercambio.', { code: 'no_draw' });
    }
    const person = q.personById.get(s.personId);
    const mine = qs.assignmentOf.get(draw.id, s.personId);
    if (!person || !mine) return fail(409, 'No encontramos tu asignación. Pregúntale al dueño del intercambio.', { code: 'no_draw' });
    const wheel = sorteo.shuffle(drawPeople(draw).filter((p) => p.id !== s.personId));
    return {
      person,
      active: draw.active,
      revealed: !!mine.revealedAt,
      revealedAt: mine.revealedAt,
      wheel,
      // El destinatario solo se envía después de girar.
      recipient: mine.revealedAt ? { id: mine.receiverId, name: mine.receiverName } : null,
    };
  },

  ruleta_spin({ p_token }) {
    const s = playerOf(p_token);
    if (!s) return NO_PLAYER;
    const draw = getDraw();
    if (!draw || !draw.participantIds.includes(s.personId)) return fail(409, 'Ya no hay un sorteo disponible para ti.', { code: 'no_draw' });
    let mine = qs.assignmentOf.get(draw.id, s.personId);
    if (!mine) return fail(409, 'No encontramos tu asignación.', { code: 'no_draw' });
    if (mine.revealedAt) {
      // Girar de nuevo (o reintentar por un error de conexión) devuelve exactamente el mismo resultado.
      return { recipient: { id: mine.receiverId, name: mine.receiverName }, revealedAt: mine.revealedAt, alreadyRevealed: true };
    }
    if (!draw.active) return fail(409, 'La ruleta está en pausa. Intenta más tarde.', { code: 'paused' });
    qs.reveal.run(nowIso(), draw.id, s.personId); // solo marca si aún no estaba revelado
    mine = qs.assignmentOf.get(draw.id, s.personId);
    return { recipient: { id: mine.receiverId, name: mine.receiverName }, revealedAt: mine.revealedAt, alreadyRevealed: false };
  },

  ruleta_recipient_gifts({ p_token }) {
    const s = playerOf(p_token);
    if (!s) return NO_PLAYER;
    const draw = getDraw();
    const mine = draw && qs.assignmentOf.get(draw.id, s.personId);
    if (!mine) return fail(409, 'No encontramos tu asignación.', { code: 'no_draw' });
    if (!mine.revealedAt) return fail(403, 'Primero gira la ruleta para descubrir a quién le regalas.');
    return { recipient: { id: mine.receiverId, name: mine.receiverName, gifts: q.giftsByPerson.all(mine.receiverId) } };
  },
};

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readJson(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket.remoteAddress || 'desconocido';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No encontrado');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      // Siempre se revalida para que cada actualización se vea de inmediato.
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
    "img-src 'self' data:", "connect-src 'self'",
    "base-uri 'none'", "form-action 'none'", "object-src 'none'", "frame-ancestors 'none'",
  ].join('; '),
  ...(IS_PROD ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const pathname = (req.url || '/').split('?')[0];

  try {
    if (pathname === '/healthz') return sendJson(res, 200, { ok: true });

    const m = pathname.match(/^\/api\/rpc\/([a-z_]+)$/);
    if (m) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Método no permitido.' });
      if (!(req.headers['content-type'] || '').includes('application/json')) {
        return sendJson(res, 415, { error: 'Formato no soportado.' });
      }
      const fn = Object.hasOwn(RPC, m[1]) ? RPC[m[1]] : null;
      if (!fn) return sendJson(res, 404, { error: 'No encontrado.' });
      const args = await readJson(req);
      return sendJson(res, 200, fn(args, { ip: clientIp(req) }));
    }
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'No encontrado.' });

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, pathname);
  } catch (err) {
    if (err.status) return sendJson(res, err.status, { error: err.status === 413 ? 'Texto demasiado largo.' : 'Solicitud inválida.' });
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Ocurrió un error en el servidor. Intenta de nuevo.' });
  }
});

server.listen(PORT, () => {
  console.log(`🎄 Intercambio Navideño escuchando en el puerto ${server.address().port}`);
  console.log(`   Base de datos: ${DB_FILE}`);
});

function shutdown() { server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
