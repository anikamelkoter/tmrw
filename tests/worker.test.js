import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { hashPassword, verifyPassword, validateEntry } from '../src/worker.js';

// Runs real SQLite statements through the D1 interface used by the Worker.
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args),
    async first() { return db.prepare(sql).get(...params) || null; },
    async all() { return { results: db.prepare(sql).all(...params) }; },
    async run() { return { meta: db.prepare(sql).run(...params) }; }
  });
  return { prepare: sql => wrap(sql), async batch(items) { db.exec('BEGIN'); try { const results=[];for (const item of items)results.push(await item.run());db.exec('COMMIT');return results; } catch (e) {db.exec('ROLLBACK');throw e;} }, close: () => db.close() };
}
function client(env, ip = '192.0.2.1') {
  let cookie = '';
  return async (path, body, method = body ? 'POST' : 'GET', headers = {}) => {
    const request = new Request('https://tmrw.test/api/' + path, {
      method, headers: { 'Content-Type':'application/json', 'X-Tmrw':'1', 'Origin':'https://tmrw.test', 'CF-Connecting-IP':ip, 'Cookie':cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const response = await worker.fetch(request, env);
    if (response.headers.has('Set-Cookie')) cookie=response.headers.get('Set-Cookie').split(';')[0];
    return { status:response.status, body:await response.json(), headers:response.headers };
  };
}
const entry = () => ({ version:0, today:'My private diary.', rating:4, yesterday:Array.from({length:3},()=>({text:'',done:false})),tomorrow:Array.from({length:3},()=>({text:'Read a book',done:false})) });
const password = 'a long unique test password';

test('salted password hashing and constant-length verification', async () => {
  const a=await hashPassword(password), b=await hashPassword(password);
  assert.notEqual(a,b); assert(!a.includes(password));
  assert.equal(await verifyPassword(password,a),true);
  assert.equal(await verifyPassword('incorrect password',a),false);
});

test('numbered accounts, private diary, second device, conflicts, logout and schema idempotence', async () => {
  const DB=database(), env={DB};
  try {
    const a=client(env), b=client(env,'192.0.2.2'), other=client(env,'192.0.2.3');
    assert.equal((await a('entries')).status,401);
    const first=await a('register',{password});assert.equal(first.body.user,1);
    assert.match(first.headers.get('Set-Cookie'),/HttpOnly; SameSite=Strict; Secure/);
    assert.equal((await b('register',{password})).body.user,2);
    assert.equal((await a('entries/2026-8-23',entry(),'PUT')).body.version,1);
    assert.deepEqual((await b('entries')).body.entries,{});
    assert.equal((await other('login',{user:'#1',password})).status,200);
    assert.equal((await other('entries')).body.entries['2026-8-23'].today,'My private diary.');
    const updated={...entry(),version:1,today:'Changed on another device.'};
    const results=await Promise.all([a('entries/2026-8-23',updated,'PUT'),other('entries/2026-8-23',updated,'PUT')]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    assert.equal((await other('entries/2026-8-23',entry(),'PUT')).status,409);
    await other('logout',{}); assert.equal((await other('entries')).status,401);
    await worker.scheduled({},env);
    assert.equal((await a('entries')).body.entries['2026-8-23'].version,2);
  } finally {DB.close();}
});

test('request guards, validation and login rate limits', async () => {
  const DB=database(), a=client({DB});
  try {
    assert.equal((await a('register',{password},'POST',{'Origin':'https://evil.test'})).status,403);
    assert.equal((await a('register',{password},'POST',{'X-Tmrw':''})).status,403);
    assert.equal((await a('register',{password:'short'})).status,400);
    for(let i=0;i<15;i++)assert.equal((await a('login',{user:999,password})).status,401);
    assert.equal((await a('login',{user:999,password})).status,429);
    assert.throws(()=>validateEntry('2026-1-30',entry()));
    assert.throws(()=>validateEntry('2026-8-23',{...entry(),rating:6}));
    assert.throws(()=>validateEntry('2026-8-23',{...entry(),tomorrow:[]}));
    assert.equal(validateEntry('2024-1-29',entry()).rating,4);
  } finally {DB.close();}
});
