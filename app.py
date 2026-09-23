"""tmrw: same-origin web app with private, versioned diary entries."""
import hashlib
import json
import os
import secrets
import sqlite3
import time
from pathlib import Path
from datetime import date
from flask import Flask, request, jsonify, g, send_from_directory
from werkzeug.security import generate_password_hash, check_password_hash


def create_app(config=None):
    app = Flask(__name__, static_folder='static')
    app.config.update(DATABASE=os.environ.get('DATABASE_PATH', 'data/tmrw.sqlite3'),
                      SECURE_COOKIE=os.environ.get('COOKIE_SECURE', '1') != '0',
                      MAX_CONTENT_LENGTH=128 * 1024)
    if config:
        app.config.update(config)
    Path(app.config['DATABASE']).parent.mkdir(parents=True, exist_ok=True)

    def db():
        if 'db' not in g:
            g.db = sqlite3.connect(app.config['DATABASE'], timeout=20)
            g.db.row_factory = sqlite3.Row
            g.db.execute('PRAGMA foreign_keys=ON')
        return g.db

    @app.teardown_appcontext
    def cleanup(_):
        if 'db' in g:
            g.db.close()

    with app.app_context():
        db().executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, password TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS entries(user_id INTEGER REFERENCES users(id), day TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(user_id,day));
        CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
        ''')

    def error(message, status=400):
        return jsonify(error=message), status

    @app.before_request
    def guard():
        if request.path.startswith('/api/'):
            if request.method != 'GET' and (request.headers.get('X-Tmrw') != '1' or not request.is_json):
                return error('Invalid request.', 403)
            token = request.cookies.get('tmrw_session', '')
            row = db().execute('SELECT user_id FROM sessions WHERE token=? AND expires>?',
                               (hashlib.sha256(token.encode()).hexdigest(), int(time.time()))).fetchone()
            g.user = row['user_id'] if row else None
            if request.path not in ('/api/me', '/api/register', '/api/login') and not g.user:
                return error('Please log in again. Your unsaved text is still on screen.', 401)

    @app.after_request
    def headers(response):
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'same-origin'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        return response

    def limited(key, maximum):
        now = int(time.time())
        conn = db()
        conn.execute('BEGIN IMMEDIATE')
        conn.execute('DELETE FROM limits WHERE expires<?', (now,))
        conn.execute('INSERT INTO limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1', (key, now+900))
        count = conn.execute('SELECT count FROM limits WHERE key=?', (key,)).fetchone()[0]
        conn.commit()
        return count > maximum

    def authenticate(uid):
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        old = request.cookies.get('tmrw_session', '')
        db().execute('DELETE FROM sessions WHERE expires<? OR token=?', (now, hashlib.sha256(old.encode()).hexdigest()))
        db().execute('INSERT INTO sessions VALUES(?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), uid, now+2592000))
        db().commit()
        response = jsonify(user=uid)
        response.set_cookie('tmrw_session', token, max_age=2592000, httponly=True,
                            secure=app.config['SECURE_COOKIE'], samesite='Strict')
        return response

    @app.get('/api/me')
    def me():
        return jsonify(user=g.user)

    @app.post('/api/register')
    def register():
        if limited('register:'+request.remote_addr, 5):
            return error('Too many attempts. Try again in 15 minutes.', 429)
        body = request.get_json()
        password = body.get('password') if isinstance(body, dict) else None
        if not isinstance(password, str) or not 12 <= len(password) <= 128:
            return error('Use a password between 12 and 128 characters.')
        uid = db().execute('INSERT INTO users(password) VALUES(?)', (generate_password_hash(password, method='scrypt'),)).lastrowid
        db().commit()
        return authenticate(uid)

    @app.post('/api/login')
    def login():
        if limited('login:'+request.remote_addr, 30):
            return error('Too many attempts. Try again in 15 minutes.', 429)
        body = request.get_json()
        if not isinstance(body, dict):
            return error('Invalid login.')
        uid = str(body.get('user', '')).lstrip('#')
        password = body.get('password', '')
        if not uid.isdigit() or len(uid)>15 or not isinstance(password, str) or len(password)>128:
            return error('Incorrect user number or password.', 401)
        if limited('account:'+uid, 15):
            return error('Too many attempts. Try again in 15 minutes.', 429)
        row = db().execute('SELECT password FROM users WHERE id=?', (int(uid),)).fetchone()
        # Check a real hash even for unknown IDs to avoid a fast failure path.
        valid = check_password_hash(row['password'] if row else app.config['DUMMY_HASH'], password)
        if not row or not valid:
            return error('Incorrect user number or password.', 401)
        return authenticate(int(uid))

    @app.post('/api/logout')
    def logout():
        token = request.cookies.get('tmrw_session', '')
        db().execute('DELETE FROM sessions WHERE token=?', (hashlib.sha256(token.encode()).hexdigest(),))
        db().commit()
        response = jsonify(ok=True)
        response.delete_cookie('tmrw_session', secure=app.config['SECURE_COOKIE'], httponly=True, samesite='Strict')
        return response

    @app.get('/api/entries')
    def entries():
        rows = db().execute('SELECT day,body,version FROM entries WHERE user_id=?', (g.user,)).fetchall()
        return jsonify(entries={r['day']:dict(json.loads(r['body']), version=r['version']) for r in rows})

    @app.put('/api/entries/<day>')
    def update(day):
        try:
            y,m,d = map(int, day.split('-'))
            date(y,m+1,d)  # Frontend keys use JavaScript's zero-based month.
            if day != f'{y}-{m}-{d}':
                raise ValueError()
            body = request.get_json()
            version = body['version']
            if type(version) is not int or version < 0:
                raise ValueError()
            if not isinstance(body['today'], str) or len(body['today']) > 50000:
                raise ValueError()
            if type(body['rating']) is not int or not 0 <= body['rating'] <= 5:
                raise ValueError()
            clean = {'today':body['today'], 'rating':body['rating']}
            for group in ('yesterday','tomorrow'):
                tasks = body[group]
                if not isinstance(tasks, list) or len(tasks)!=3:
                    raise ValueError()
                if any(not isinstance(t,dict) or not isinstance(t.get('text'),str) or len(t['text'])>200 or type(t.get('done')) is not bool for t in tasks):
                    raise ValueError()
                clean[group] = [{'text':t['text'],'done':t['done']} for t in tasks]
        except (ValueError, TypeError, KeyError):
            return error('Invalid entry.')
        conn=db()
        conn.execute('BEGIN IMMEDIATE')
        current=conn.execute('SELECT version FROM entries WHERE user_id=? AND day=?',(g.user,day)).fetchone()
        if (current['version'] if current else 0) != version:
            conn.rollback()
            return error('This day changed on another device. Copy your unsaved text, then reload before editing again.',409)
        conn.execute('INSERT INTO entries VALUES(?,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET body=excluded.body,version=excluded.version', (g.user,day,json.dumps(clean),version+1))
        conn.commit()
        return jsonify(version=version+1)

    @app.get('/')
    def index():
        return send_from_directory(app.static_folder, 'index.html')

    app.config['DUMMY_HASH'] = generate_password_hash(secrets.token_urlsafe(24), method='scrypt')
    return app

app = create_app()
if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000)
