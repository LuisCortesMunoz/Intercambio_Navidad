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
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

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
    'SELECT id, name, description, created_at AS createdAt FROM gifts WHERE person_id = ? ORDER BY id'),
  allGifts: db.prepare(
    'SELECT id, person_id AS personId, name, description, created_at AS createdAt FROM gifts ORDER BY id'),
  insertGift: db.prepare('INSERT INTO gifts (person_id, name, description) VALUES (?, ?, ?)'),
  giftByPersonAndName: db.prepare('SELECT id FROM gifts WHERE person_id = ? AND lower(name) = lower(?)'),
  deleteGift: db.prepare('DELETE FROM gifts WHERE id = ?'),
};

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

setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of sessions) if (exp < now) sessions.delete(k);
  for (const [ip, a] of loginAttempts) if (a.until < now && a.fails === 0) loginAttempts.delete(ip);
}, 10 * 60 * 1000).unref();

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

  add_gift({ p_person_id, p_name, p_description }) {
    const person = q.personById.get(asId(p_person_id));
    if (!person) return fail(404, 'Esta persona ya no existe.');
    const name = cleanText(p_name).replace(/\n/g, ' ');
    const description = cleanText(p_description);
    if (!name && !description) return fail(400, 'Falta el nombre del regalo y la descripción.');
    if (!name) return fail(400, 'Falta el nombre del regalo.');
    if (!description) return fail(400, 'Falta la descripción.');
    if (name.length > 100) return fail(400, 'El nombre del regalo es muy largo (máx. 100 caracteres).');
    if (description.length > 1500) return fail(400, 'La descripción es muy larga (máx. 1500 caracteres).');
    if (q.giftByPersonAndName.get(person.id, name)) return fail(409, `Ya registraste una opción llamada "${name}".`);
    const info = q.insertGift.run(person.id, name, description);
    return { gift: { id: Number(info.lastInsertRowid), name, description } };
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
    return q.deletePerson.run(asId(p_id)).changes ? { ok: true } : fail(404, 'La persona ya no existe.');
  },

  admin_delete_gift({ p_token, p_id }) {
    if (!isAdmin(p_token)) return ADMIN_EXPIRED;
    return q.deleteGift.run(asId(p_id)).changes ? { ok: true } : fail(404, 'La opción ya no existe.');
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
      'Cache-Control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=300',
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
  console.log(`🎄 Intercambio Navideño escuchando en el puerto ${PORT}`);
  console.log(`   Base de datos: ${DB_FILE}`);
});

function shutdown() { server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
