# tmrw

A black-and-white diary and calendar. Each day expands into a journal, a five-shade rating, yesterday's checklist, and plans for tomorrow.

## Included

- The approved calendar design, gray hover, smooth expand/collapse, and saved rating shades.
- Numbered accounts with a password. The first account created in an empty database is #1, then #2, and so on. Create your account before sharing the site if you want #1.
- Three plans for tomorrow. The next day reads those plans as its “from yesterday” checklist. Completion is tracked on the next day, independently of the original list. If the original text changes, the associated completion resets.
- Diary text, checklist changes, and ratings autosave to the server.
- Cross-device access using the same account number and password. Reload or refocus the calendar to fetch other-device changes. Simultaneous conflicting edits are rejected instead of silently overwriting data; copy unsaved text before reloading when warned.
- Password hashes (scrypt), HTTP-only session cookies, login rate limits, private per-account database queries, and version checks.

## Run on your computer

Use Python 3.12 or later. From this folder:

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
COOKIE_SECURE=0 python app.py
```

Open http://127.0.0.1:5000. The profile icon opens login and account creation. Create a password of at least 12 characters and keep your assigned number.

On Windows PowerShell, activate with `.venv\Scripts\Activate.ps1`, then set `$env:COOKIE_SECURE="0"` and run `python app.py`.

The database is created in `data/`. Local operation is for testing; it does not make your computer a public website. Demo entries from the earlier ChatGPT preview are not automatically imported.

## Upload to GitHub

1. Unzip this download.
2. Open your `tmrw` repository on GitHub.
3. Choose **Add file → Upload files**.
4. Upload the contents of this folder, including the `static` and `tests` folders. Upload the files, not the ZIP itself.
5. Commit the upload. Do not upload `data/`, `.venv/`, passwords, or database files.

If using Git locally, `.gitignore` already excludes those files. No GitHub commit or deployment was made when this package was created.

## Make accounts work across devices

GitHub stores your source code. **GitHub Pages cannot run this Python server or database.** Host the complete app on a Python or Docker web host, and use that host's HTTPS URL for the site. Keep frontend and API on the same origin.

### Python host configuration

- Install: `pip install -r requirements.txt`
- Start: `gunicorn --bind 0.0.0.0:8000 --workers 2 --threads 2 app:app`
- Route the host's HTTPS traffic to port 8000 (or substitute its required port).
- Mount a persistent writable disk at `/data`.
- Set `DATABASE_PATH=/data/tmrw.sqlite3`.
- Set `COOKIE_SECURE=1` (the default). Use HTTPS; do not disable secure cookies in production.
- Run one app instance with the same persistent disk. Multiple workers on that instance are supported; separate replicas with separate disks are not.

### Docker option

```sh
docker build -t tmrw .
docker volume create tmrw-data
docker run -p 8000:8000 -v tmrw-data:/data tmrw
```

Put this behind your host's HTTPS proxy. For local HTTP testing only, add `-e COOKIE_SECURE=0` to `docker run`.

Use a persistent volume: an ephemeral filesystem will lose accounts when replaced or redeployed. Back up the database regularly using SQLite's backup API. Keep backups private. No provider account or hosting subscription is included.

## Current limits

- No password reset or recovery email yet. Forgotten passwords cannot be recovered through the app. User numbers are identifiers, not secrets.
- Requires an internet connection for saves. Failed saves remain on screen with a warning; keep the tab open until saved. Unsaved edits are not an offline backup.
- Diary text is stored in the database without end-to-end encryption. The server administrator can access it.
- Authentication limits use the server-observed IP. Behind a proxy these limits may be shared by visitors; configure trusted proxy handling for your specific host before a broad public launch. Do not blindly trust forwarded IP headers.
- This is a small-app implementation, not a completed security audit. Account deletion, password recovery and larger-scale infrastructure can be added next.

## Tests

```sh
python -m unittest discover -s tests -v
```

Tests cover account numbering, authentication, separate-user privacy, cross-client retrieval, edit conflicts, logout, validation, CSRF request headers and rate limiting. The visual design is carried forward from the approved demo; this package has not been tested in a real browser here.

Implementation references: [Flask production deployment](https://flask.palletsprojects.com/en/stable/deploying/) and [Flask security considerations](https://flask.palletsprojects.com/en/stable/web-security/).
