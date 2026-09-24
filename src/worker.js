import { scrypt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { ensureSchema } from './schema.js';

const SESSION_SECONDS = 30 * 24 * 3600;
const COOKIE = 'tmrw_session';
const now = () => Math.floor(Date.now() / 1000);
const digest = value => createHash('sha256').update(value).digest('hex');
const derive = (password, salt) => new Promise((resolve, reject) => {
  scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key));
});
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt);
  return `scrypt:32768:8:1$${salt}$${hash.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [method, salt, hash] = stored.split('$');
  if (method !== 'scrypt:32768:8:1' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{64}$/.test(hash)) return false;
  return timingSafeEqual(await derive(password, salt), Buffer.from(hash, 'hex'));
}
// Unknown IDs still take the same expensive hash path, without hashing on cold start.
const dummy = 'scrypt:32768:8:1$00000000000000000000000000000000$' + '0'.repeat(64);
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY'
};
function json(body, status = 200, extra = {}) {
  return Response.json(body, { status, headers: { ...securityHeaders, ...extra } });
}
class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function fail(message, status = 400) { throw new HttpError(message, status); }
function tokenFrom(request) {
  return request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
}
function cookie(request, token, age = SESSION_SECONDS) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Strict${secure}`;
}
async function readBody(request) {
  // Enforce size while streaming; do not trust Content-Length alone.
  if (Number(request.headers.get('Content-Length') || 0) > 256 * 1024) fail('Entry is too large.', 413);
  if (!request.body) fail('A JSON body is required.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 256 * 1024) { await reader.cancel(); fail('Entry is too large.', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('Invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Invalid JSON object.');
  return body;
}
async function rateLimit(db, key, maximum) {
  const time = now();
  const row = await db.prepare(`INSERT INTO limits(key,count,expires) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,
      expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END
    RETURNING count`).bind(key, time + 900, time, time).first();
  if (row.count > maximum) fail('Too many attempts. Try again in 15 minutes.', 429);
}
function passwordValue(body) {
  if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) {
    fail('Use a password between 12 and 128 characters.');
  }
  return body.password;
}
async function signIn(db, request, user) {
  const token = randomBytes(32).toString('hex');
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE token=?').bind(digest(tokenFrom(request))),
    db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').bind(digest(token), user, now() + SESSION_SECONDS)
  ]);
  return json({ user }, 200, { 'Set-Cookie': cookie(request, token) });
}
export function validateEntry(day, body) {
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(day)) fail('Invalid date.');
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m, d));
  if (y < 1900 || y > 9999 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m || date.getUTCDate() !== d || day !== `${y}-${m}-${d}`) fail('Invalid date.');
  if (!Number.isSafeInteger(body.version) || body.version < 0) fail('Invalid version.');
  if (typeof body.today !== 'string' || body.today.length > 50000) fail('Diary entries can contain up to 50,000 characters.');
  if (!Number.isInteger(body.rating) || body.rating < 0 || body.rating > 5) fail('Invalid rating.');
  const clean = { today: body.today, rating: body.rating };
  for (const group of ['yesterday', 'tomorrow']) {
    if (!Array.isArray(body[group]) || body[group].length !== 3) fail('Invalid checklist.');
    clean[group] = body[group].map(task => {
      if (!task || typeof task.text !== 'string' || task.text.length > 200 || typeof task.done !== 'boolean') fail('Invalid task.');
      return { text: task.text, done: task.done };
    });
  }
  return clean;
}
async function handleApi(request, env) {
  const { pathname, origin } = new URL(request.url);
  if (!env.DB) fail('The database is not connected yet.', 503);
  if (!['GET', 'POST', 'PUT'].includes(request.method)) fail('Method not allowed.', 405);
  if (request.method !== 'GET') {
    const requestOrigin = request.headers.get('Origin');
    if (request.headers.get('X-Tmrw') !== '1' || !request.headers.get('Content-Type')?.startsWith('application/json') || (requestOrigin && requestOrigin !== origin)) fail('Invalid request.', 403);
  }
  await ensureSchema(env.DB);
  const db = env.DB;
  const session = await db.prepare('SELECT user_id FROM sessions WHERE token=? AND expires>?')
    .bind(digest(tokenFrom(request)), now()).first();
  const user = session?.user_id || null;
  if (pathname === '/api/me' && request.method === 'GET') return json({ user });
  if ((pathname === '/api/register' || pathname === '/api/login') && request.method === 'POST') {
    if (user) fail('Log out before switching accounts.', 409);
    const body = await readBody(request);
    // CF-Connecting-IP is supplied by Cloudflare, not a client-controlled forwarded header.
    const ip = digest(request.headers.get('CF-Connecting-IP') || 'local');
    if (pathname === '/api/register') {
      await rateLimit(db, 'register:' + ip, 5);
      const password = passwordValue(body);
      const stored = await hashPassword(password);
      const row = await db.prepare('INSERT INTO users(password,created_at) VALUES(?,?) RETURNING id').bind(stored, now()).first();
      return signIn(db, request, row.id);
    }
    await rateLimit(db, 'login:' + ip, 30);
    const id = String(body.user ?? '').replace(/^#/, '');
    if (!/^[1-9]\d{0,14}$/.test(id) || typeof body.password !== 'string' || body.password.length > 128) fail('Incorrect user number or password.', 401);
    await rateLimit(db, 'account:' + id, 15);
    const row = await db.prepare('SELECT id,password FROM users WHERE id=?').bind(Number(id)).first();
    const valid = await verifyPassword(body.password, row?.password || dummy);
    if (!row || !valid) fail('Incorrect user number or password.', 401);
    return signIn(db, request, row.id);
  }
  if (!user) fail('Please log in again. Copy any unsaved text before reloading.', 401);
  if (pathname === '/api/logout' && request.method === 'POST') {
    await db.prepare('DELETE FROM sessions WHERE token=?').bind(digest(tokenFrom(request))).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', 0) });
  }
  if (pathname === '/api/entries' && request.method === 'GET') {
    const { results } = await db.prepare('SELECT day,body,version FROM entries WHERE user_id=?').bind(user).all();
    return json({ entries: Object.fromEntries(results.map(row => [row.day, { ...JSON.parse(row.body), version: row.version }])) });
  }
  if (pathname.startsWith('/api/entries/') && request.method === 'PUT') {
    const day = pathname.slice('/api/entries/'.length);
    const body = await readBody(request);
    const clean = validateEntry(day, body);
    let result;
    if (body.version === 0) {
      result = await db.prepare('INSERT INTO entries(user_id,day,body,version) VALUES(?,?,?,1) ON CONFLICT(user_id,day) DO NOTHING RETURNING version')
        .bind(user, day, JSON.stringify(clean)).first();
    } else {
      result = await db.prepare('UPDATE entries SET body=?,version=version+1 WHERE user_id=? AND day=? AND version=? RETURNING version')
        .bind(JSON.stringify(clean), user, day, body.version).first();
    }
    if (!result) fail('This day changed on another device. Copy your unsaved text, then reload before editing again.', 409);
    return json(result);
  }
  fail('Not found.', 404);
}
export default {
  async fetch(request, env) {
    try {
      if (new URL(request.url).pathname.startsWith('/api/')) return await handleApi(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status, error.status === 429 ? { 'Retry-After': '900' } : {});
      // Do not expose SQL, credentials or diary content through logs/errors.
      return json({ error: 'The server could not complete this request. Keep unsaved text open and retry.' }, 503);
    }
  },
  async scheduled(_controller, env) {
    await ensureSchema(env.DB);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires<=?').bind(now()),
      env.DB.prepare('DELETE FROM limits WHERE expires<=?').bind(now())
    ]);
  }
};
