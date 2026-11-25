# TMRKZ — the full process: from the Windows PC to the offline VM

This folder is the whole application: code, settings, images and data. It needs no internet.

### The folder — the same on the PC, the USB stick and the VM

Everything at the top of the folder, and nothing else:

| In the folder | What it is |
|---|---|
| `docker-compose.yml` + `docker-compose.override.yml` | how everything runs (Compose reads both automatically) |
| `.env` | every setting and password (hidden file: `ls -a` shows it) |
| `start.sh` | asks for the IP address and the port, loads the images, starts everything |
| `tmrkz-images.tar` + `tmrkz-images.tar.sha256` | all Docker images in one file (about 1 GB) and its checksum |
| `data/` | the data: `data/db` (PostgreSQL 17 database), `data/files` (uploads), `data/ldap-data` + `data/ldap-config` (local directory) |
| `backups/` | database backups and dumps (`ops/backup.sh` writes here; the migration center reads it) |
| `backend/`, `frontend/` | the code — a saved change is rebuilt and live in about 25 seconds, no image build |
| `map-data/` | the offline map: `map-data/runtime/current` (base map, 3D terrain, fonts, styles) |
| `map-packages/` | the map package files the backend reads |
| `ops/` | the scripts; `ops/local/.generated/` holds the local directory's certificates and password, `ops/tls/private/` the https certificate |
| `docs/`, `handoff/`, `tests/`, `assets/`, `prototypes/` | documentation, specifications, tests, shared assets, earlier prototypes |
| `RUN.md`, `README.md`, `CLAUDE.md`, `AGENTS.md`, `FINAL_HANDOFF_2026-11-18.md`, `FONT-LICENSE.txt` | this guide and the project's notes and licence |
| `.gitignore`, `.gitattributes`, `.github/`, `.vscode/`, `.zcode/`, `.git/` | git and editor files (`.git` only where git is used) |

Anything else does not belong at the top: `start.sh` names it when it starts. Where such things go:
- the transfer files `TMRKZ.zip` and `TMRKZ.zip.sha256`: the home folder (`~`), outside `TMRKZ`;
- a database backup or dump (`*.backup`, `*.dump`, `*.db`): `backups/`;
- the https certificate and key: `ops/tls/private/` (`sh ops/tls/install-cert.sh` puts them there).

Sign-in accounts: `developer` and `admin`. Their passwords are in `.env`:
`TMRKZ_PLATFORM_DEVELOPER_PASSWORD` and `TMRKZ_PLATFORM_ADMIN_PASSWORD`.
The database has **no password**: it accepts only TMRKZ's own containers, on an internal network with no route out.

---

## 1. On the Windows PC — make the zip (Command Prompt)

Open **Command Prompt** (Start → type `cmd` → Enter) and type each line, one after the other.

1. **Enter the folder.**
   ```
   cd /d "%USERPROFILE%\Desktop\TMRKZ"
   ```
2. **Stop TMRKZ.** A database copied while it runs can be damaged.
   ```
   docker compose stop
   ```
3. **Make the zip** on the Desktop. The dot at the end means "everything in this folder", hidden files such as `.env`
   included. It leaves out only what the VM does not need: the git history `.git` (it stays on this PC; the VM starts its
   own, section 10), the Windows-only `node_modules` folders, and the test evidence `docs/evidence`.
   ```
   %SystemRoot%\System32\tar.exe -a -c -f "%USERPROFILE%\Desktop\TMRKZ.zip" --exclude ./.git --exclude node_modules --exclude ./backend/target --exclude ./docs/evidence .
   ```
4. **Start TMRKZ again.**
   ```
   docker compose up -d
   ```
5. **Write the zip's checksum** next to it (the VM checks the copy with it).
   ```
   cd /d "%USERPROFILE%\Desktop"
   powershell -NoProfile -Command "[IO.File]::WriteAllText((Join-Path $PWD 'TMRKZ.zip.sha256'), (Get-FileHash TMRKZ.zip -Algorithm SHA256).Hash.ToLower() + '  TMRKZ.zip' + [char]10)"
   ```

Never copy the folder by selecting the files inside it (Ctrl+A in Explorer, Cmd+A in Finder): that skips the hidden
files — `.env` first of all — and copies a running database. Always send the zip.

## 2. Send the zip to the VM through PAM (SSH port 4422)

Still in Command Prompt, in the Desktop folder. Put your own PAM login in the first line — the same text you use with
`ssh -p 4422 …`:

```
cd /d "%USERPROFILE%\Desktop"
set PAM=DOMAIN\username+DOMAIN\pam_u123456+PORT@pam.domain
scp -P 4422 TMRKZ.zip TMRKZ.zip.sha256 "%PAM%:"
```

- `scp` and `sftp` write the port with a capital `-P`; `ssh` with a small `-p`.
- The two files land in your home folder on the VM (`~`).
- If PAM refuses `scp`, use `sftp` (it can also resume a copy that broke off):
  ```
  sftp -P 4422 "%PAM%"
  put TMRKZ.zip
  put TMRKZ.zip.sha256
  exit
  ```
  After a broken copy: connect again and type `reput TMRKZ.zip` instead of `put TMRKZ.zip`.
- Without PAM, a USB stick works too. A FAT32 stick cannot hold a file over 4 GB: split the zip in Git Bash with
  `split -b 3900m -d -a 1 TMRKZ.zip TMRKZ.zip.part`, and join it on the VM with `cat TMRKZ.zip.part0 TMRKZ.zip.part1 > TMRKZ.zip`.

## 3. On the VM — put the folder in place

Connect: `ssh -p 4422 "%PAM%"` (the same login), then:

1. **Check the copy.** It must print `TMRKZ.zip: OK`.
   ```
   cd ~
   sha256sum -c TMRKZ.zip.sha256
   ```
2. **Stop the TMRKZ that runs now and keep its folder** until the new one works (nothing is deleted).
   ```
   cd ~/TMRKZ && docker compose down; cd ~
   mv ~/TMRKZ ~/TMRKZ.before-$(date +%Y%m%d)
   ```
   (Skip this step the first time, when there is no `~/TMRKZ` yet.)
3. **Unzip into a new folder TMRKZ on the VM's own disk** — not a VirtualBox shared folder (`/media/sf_...`): PostgreSQL
   refuses to run there.
   ```
   mkdir -p ~/TMRKZ && cd ~/TMRKZ
   unzip -q ~/TMRKZ.zip
   ```
   If `unzip` is missing: `python3 -m zipfile -e ~/TMRKZ.zip ~/TMRKZ`
4. **Check what you got.** `ls -a` shows hidden files; `.env` must be in the list.
   ```
   ls -a ~/TMRKZ
   ```
   You should see `docker-compose.yml`, `docker-compose.override.yml`, `.env`, `start.sh`, `tmrkz-images.tar`, `data`, `backend`, `frontend` and the rest.
5. **Check the settings** before the first start: `nano ~/TMRKZ/.env`. Every setting TMRKZ reads is there, in
   sections — the address, the platform accounts, **the AI assistant** (section 3: `TMRKZ_AI_ENABLED`, the model server's
   `TMRKZ_AI_BASE_URL`, `TMRKZ_AI_MODEL`, `TMRKZ_AI_API_KEY`), the directory, Keycloak, HR, features. The values are the
   PC's: change the AI server to the VM's. Section 8 (internal keys) must not be changed. Settings saved later in
   «إعدادات النظام ← إعدادات التكامل» take precedence over `.env`.
6. **Bring over only the VM's own files from the old folder,** each into its place in the new one (the folder section at
   the top). Only if the VM uses https, its certificate and key:
   ```
   mkdir -p ~/TMRKZ/ops/tls/private && cp -a ~/TMRKZ.before-*/https-certs/. ~/TMRKZ/ops/tls/private/
   ls ~/TMRKZ/ops/tls/private        # the https entry point reads server.crt and server.key here
   ```
   If they have other names, install them properly: `sh ops/tls/install-cert.sh <certificate> <CA chain>` (ops/tls/README.md).
   A database backup of the old VM, if you want to keep it: `cp ~/TMRKZ.before-*/*.backup ~/TMRKZ/backups/`.
   Nothing else is copied: the new folder already has everything else.

The old VM folder stays in `~/TMRKZ.before-<date>`; delete it once the new one works (`rm -rf ~/TMRKZ.before-<date>`).

## 4. On the VM — first start

1. **Check Docker.** You need Docker Compose v2.24 or newer. If `docker` needs `sudo`, prefix the commands with `sudo`.
   ```
   docker --version
   docker compose version
   ```
2. **Find the VM's IP address.**
   ```
   hostname -I
   ```
3. **Start.**
   ```
   cd ~/TMRKZ
   sh start.sh
   ```
   It asks two questions:
   - **IP address:** the address people will open. `127.0.0.1` means only inside the VM.
   - **Port:** for example `8088`.

   It then does five things:
   - uses the images already loaded on the machine; only when one is missing (or a newer `tmrkz-images.tar` is in the folder)
     it checks and loads `tmrkz-images.tar` (1–2 minutes). An installation whose images are loaded needs neither the archive
     nor its checksum file (ADR-104);
   - writes the address into `.env`;
   - checks the Compose files: a third file such as `docker-compose.dc-hosts.yml` must be named in `.env`
     (`COMPOSE_PATH_SEPARATOR=:` and `COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.dc-hosts.yml`);
     otherwise it stops and says so — a plain `docker compose up -d` would silently leave that file out;
   - runs `docker compose up -d`;
   - waits until TMRKZ answers. The first start builds the code inside the containers and takes a few minutes.

   The same by hand: set `TMRKZ_IP` and `TMRKZ_PORT` at the top of `.env`, then
   ```
   docker load -i tmrkz-images.tar
   docker compose up -d
   ```
4. **Open** `http://<IP>:<PORT>` and sign in.
   - The manual form: `developer` with its password.
   - Or the automatic button, which opens Keycloak's sign-in page.
5. **Check that everything is up.**
   ```
   docker compose ps
   ```
   - Running and healthy: `db`, `keycloak`, `openfga`, `backend`, `web-build`, `web`, `openldap`, and `maintenance` (the Update
     Center's worker, ADR-104).
   - Read-only check of the whole installation (changes nothing, output redacted): `sh ops/diagnose.sh`.
   - Finished with `Exited (0)` (correct for one-time jobs): `db-init`, `openfga-migrate`, `keycloak-setup`.
6. **Reach it from other computers.**
   - Open the port in the firewall, if one is active: `sudo ufw allow 8088/tcp`
   - In VirtualBox, a **Bridged** network adapter gives the VM its own LAN address.
   - With **NAT**, add a port forward instead (host 8088 → guest 8088). People then open the host computer's IP.

## 5. Daily use (on the VM or on the PC)

| What | Command (inside the TMRKZ folder) |
|---|---|
| start | `docker compose up -d` |
| stop (data stays in `data/`) | `docker compose stop` |
| status | `docker compose ps` |
| watch the code builds | `docker compose logs -f backend web-build` |
| after changing `.env` | `docker compose up -d` |
| change the IP address or port | `sh start.sh` again |
| copy or back up everything | `docker compose stop`, copy or zip the whole folder, `docker compose up -d` |

**Never** run `docker compose down -v`, and never delete files inside `data/`.

## 5a. Updating from the browser — «مركز التحديث» (ADR-104)

The VM is updated from the same TMRKZ folder you develop in; no separate deployment folder, no PAM command for routine
updates. Details, the one-time set-up and the recovery steps: `docs/UPDATE_CENTER_AR.md`.

1. On the PC, in the TMRKZ folder (Command Prompt): `"C:\Program Files\Git\bin\sh.exe" ops/update/make-release.sh`
   — signs the list of application files (`release/`).
2. Copy the TMRKZ folder to the computer that opens the VM's page (USB), open TMRKZ → «إدارة النظام» → «مركز التحديث»,
   choose the folder. The page shows what is added, changed and deleted; only those files are uploaded.
3. Write the reason, «اعتماد وتطبيق». The worker builds offline with the existing libraries, backs up, applies, restarts
   only what changed and verifies — or rolls back by itself. «الرجوع إلى الإصدار السابق» undoes a finished update.

`.env`, `certs/`, `data/`, `backups/`, `map-data/`, `map-runtime/`, `docker-compose.dc-hosts.yml` and `ops/local/.generated/`
are never touched by an update; the Compose files change only when you select them.

## 6. Changing the code

1. **Edit** files in `backend/` (Java) or `frontend/` (React/TypeScript) and save.
2. **Watch the rebuild.**
   ```
   docker compose logs -f --since 1m backend web-build
   ```
   - success: `[backend] build ready` → `Started TmrkzApplication`, and `[web] published`
   - `BUILD FAILED`: the previous version keeps running. Read the error, fix it, save again.
3. **Run tests, offline.**
   - Frontend, one or more test files:
     ```
     docker run --rm --network none --entrypoint sh -v "$PWD/frontend:/src:ro" tmrkz/folder-web:1 -c 'mkdir /w && tar -C /src --exclude=./node_modules --exclude=./dist -cf - . | tar -C /w -xf - && ln -s /modules/node_modules /w/node_modules && cd /w && npx vitest run src/lib/signInNotes.test.ts'
     ```
   - Backend test classes. They use a throw-away database, never `data/`. The first command is needed once only:
     ```
     docker run --rm --entrypoint true -v tmrkz-m2:/root/.m2 tmrkz/folder-backend:1
     TMRKZ_TEST_MAVEN_IMAGE=tmrkz/folder-backend:1 TMRKZ_TEST_MAVEN_VOLUME=tmrkz-m2 sh ops/test-backend.sh OracleUnitImportIT
     ```
4. **Database changes:** a new file in `backend/src/main/resources/db/migration` with the next number (now `V55__...sql`).
   Never edit an existing migration.

## 7. Bringing in your offline database

The database has no password, so passwords no longer need to match.

1. **Stop TMRKZ and move the current database aside.**
   ```
   docker compose stop
   mv data/db data/db.before
   ```
2. **Put your database in as `data/db`.**
   - **If it is a PostgreSQL folder** (it contains `PG_VERSION`, `base`, `global`, `pg_wal`): copy it to `data/db`.
     `cat data/db/PG_VERSION` must print `17`.
   - **If it is inside Docker on the old installation:** run this there, then bring `data/db` over.
     ```
     docker run --rm -v tmrkz-mover_db-data:/from:ro -v "$PWD/data/db:/to" postgis/postgis:17-3.5-alpine cp -a /from/. /to/
     ```
     Do the same for uploaded files: `tmrkz-mover_files` → `data/files`.
3. **Start.**
   ```
   docker compose up -d
   ```
   - An older database (V54 or below) is upgraded automatically.
   - `keycloak-setup` sets the `developer` and `admin` passwords from `.env`, the sign-in address, the local directory's password and the sign-in client's secret.
4. **Check.** Sign in, look at the units and requests, and run `docker compose ps`.
5. **The HR (Oracle) connection.** If its sync fails, enter the Oracle password again in «إعدادات النظام ← مصدر الموارد البشرية».
   The other machine stored it with its own `TMRKZ_HR_SETTINGS_KEY`.
6. **Remove the old copy** when everything works:
   ```
   rm -rf data/db.before
   ```

## 8. The enterprise directory and the enterprise Keycloak — in the application, not in files

As in MOVER's «إعدادات التكامل». Sign in as `admin` or `developer`, open **إعدادات النظام → إعدادات التكامل**:

1. **الدليل المؤسسي (LDAP)** — the server's DNS name (the one its certificate was issued for), LDAPS 636 or StartTLS 389,
   the sign-in domain (people sign in as `user@domain`), the search base (`DC=…,DC=…`), the attributes (press
   «Active Directory (كما في MOVER)»), and the CA certificate pasted as PEM (get it with
   `openssl s_client -connect <server>:636 -showcerts` on a machine that reaches it, and paste the CA certificates,
   not the server's own). Press **اختبار الاتصال** — with a real username and password it tries that person's sign-in —
   then **حفظ**. It is in force at once: no restart, nothing in `.env`.
   **No service account is needed (ADR-100):** leave «حساب الخدمة» empty. Each person's own username and password are
   checked by the directory (bind as `user@domain`); with «نطاق الدخول» empty the domain is the `DC=` parts of the search
   base (`DC=corp,DC=example` → `corp.example`). People sign in with **«إدخال رقم الـــــ U وكلمة المرور يدويا»** and may type
   `user`, `DOMAIN\user` or `user@domain`. The automatic button opens the local Keycloak, which can look people up in the
   directory only with a service account; without one it is for `admin` and `developer`, until an enterprise Keycloak is
   saved in step 2.
2. **الدخول الآلي (Keycloak)** — the enterprise Keycloak's address, realm, TMRKZ's client ID and secret (ask the
   Keycloak team for a confidential client with the return address shown on the screen), the CA if internal.
   **اختبار الاتصال**, then **حفظ**. The automatic button now goes there; `admin` and `developer` keep the local Keycloak.
3. The address people open is one setting, `TMRKZ_PUBLIC_URL` in `.env` (written by `start.sh`, or `https://…` by
   `ops/tls/enable.sh`): every sign-in address derives from it. Nothing in `docker-compose*.yml` is edited by hand.

Nothing typed for a test is stored; saved secrets are encrypted and never shown again. «العودة إلى إعدادات ملف البيئة»
removes the saved section and the `.env` values apply again.

## 9. A new library, or newer server images (a connected machine only)

When `backend/pom.xml` or `frontend/package-lock.json` gets a new dependency, the offline machine cannot download it.

1. **On a machine with internet, in the TMRKZ folder:**
   ```
   sh ops/local/workspace/pack-images.sh
   ```
2. **Carry the new files** `tmrkz-images.tar` and `tmrkz-images.tar.sha256` to the VM's TMRKZ folder.
3. **On the VM:**
   ```
   sh start.sh
   ```
   It loads the new images by itself.

## 10. Working with the AI agent (GLM 5.3 Flash) on the VM

1. **Open the agent** with `~/TMRKZ` as its working folder.
2. **Paste the prompt** from **Appendix A** as its system prompt (or first message), once per session.
3. **Start a local history, once.** The zip carries no git history.
   `.gitignore` keeps `data/`, `.env` and `tmrkz-images.tar` out of it. It stays on the VM; never push from the VM.
   ```
   cd ~/TMRKZ
   git init -q && git config user.name "TMRKZ VM" && git config user.email "vm@tmrkz.local"
   git add -A && git commit -q -m "baseline as received"
   ```
   **Make a checkpoint before each task:**
   ```
   git add -A && git commit -q -m "checkpoint before agent task"
   ```
4. **Give one clear task at a time.** Example:
   *"In the sign-in page, make the subtitle smaller. Change only frontend/src/styles/signin.css. Check it in the browser and report."*
5. **After the task, check what it changed.**
   ```
   git status
   git diff --stat
   git diff <file>
   ```
6. **Undo a bad change** to one file, back to your checkpoint:
   ```
   git restore <file>
   ```
7. **Red flags.** Stop the agent if it:
   - touches `data/`, `.env`, `docker-compose*.yml`, `start.sh`, `ops/local/workspace/` or an existing migration
     (the directory and Keycloak are entered in the application, section 8 — never by editing these files);
   - tries to download or install anything;
   - says "done" without a test or a browser check.

## 11. When something is wrong

| You see | Do |
|---|---|
| the page does not open | `docker compose ps`, then `docker compose logs --tail 80 backend web-build web` |
| `BUILD FAILED` in the logs | the last saved change has an error; fix it — the previous version keeps running |
| sign-in fails | `docker compose logs keycloak-setup` must end with `password client ready`; then `docker compose up -d` |
| `db` restarts again and again | is the folder on a VirtualBox shared folder? Move it to the VM's own disk |
| the backend logs `OpenFGA unreachable` (or another service's name) after a start that recreated a network | a container kept from before lost its name on the new network: `docker compose up -d --force-recreate` |
| `TMRKZ_IP` error when starting | write `TMRKZ_IP` and `TMRKZ_PORT` at the top of `.env`, or run `sh start.sh` |
| a port is already in use | run `sh start.sh` and choose another port |
| the map is empty | `ls map-data/runtime/current` must list `basemap`, `terrain`, `styles` and `fonts` |

---

## Appendix A — the prompt for the AI agent (GLM 5.3 Flash)

Paste everything between the two lines.

----------------------------------------------------------------------------------------------------

# You are the coding agent for TMRKZ on an OFFLINE machine

You work inside the folder `TMRKZ` (the current directory). This folder IS the whole application:
code, settings, images and data. The machine has NO internet. The owner gives you tasks; you make
small, correct changes, check them, and report honestly. Reply to the owner in the language they use.

`RUN.md` (how to run) and this prompt override anything older. `AGENTS.md` is history: its
`docker compose up -d --build` and `ops/local/up.sh` instructions are OUT OF DATE — never use them.

## 1. How the application runs (facts — do not change them)

- Start: `docker compose up -d` (or `sh start.sh`, which asks for the IP address and port).
  Stop: `docker compose stop`. Status: `docker compose ps`.
- `docker-compose.yml` (base) + `docker-compose.override.yml` (read automatically) — project `tmrkz`.
- `.env`: `TMRKZ_IP` and `TMRKZ_PORT` at the top = the address people open. After editing `.env`: `docker compose up -d`.
- `tmrkz-images.tar`: all images, loaded with `docker load -i tmrkz-images.tar`. Nothing is ever pulled.
- `data/db`: the PostgreSQL 17 database (NO password; rules in `ops/local/workspace/pg_hba.conf`).
  `data/files`: uploaded files. `data/ldap-data`, `data/ldap-config`: the local LDAP directory.
- `map-data/runtime/current`: the offline map package, served at `/map-data/`. Never move or delete it.
- `backend/`: Spring Boot 4, Java 25. Flyway migrations in `backend/src/main/resources/db/migration` (latest V54).
  `frontend/`: React 19 + Vite + TypeScript, Arabic right-to-left UI.
- **Code changes rebuild themselves.** Save a file → within ~25 s the container rebuilds it.
  Watch: `docker compose logs -f --since 1m backend web-build`
  - success: `[backend] build ready` then `Started TmrkzApplication`; `[web] published`
  - failure: `BUILD FAILED` — the old version keeps running; read the error and fix it.
- Sign-in: `developer` or `admin`; their passwords are `TMRKZ_PLATFORM_DEVELOPER_PASSWORD` and
  `TMRKZ_PLATFORM_ADMIN_PASSWORD` in `.env` (use them, never print them).
  The automatic button opens Keycloak's standard sign-in page (the local realm `tmrkz` under `/auth`, or the
  enterprise Keycloak when one is saved in «إعدادات التكامل»). The manual form checks the directory saved in
  «إعدادات التكامل» directly (ADR-092); the address people open is `TMRKZ_PUBLIC_URL` in `.env`.
  The service `keycloak-setup` configures the local Keycloak on every `docker compose up -d`. Do NOT run
  `ops/platform-accounts.sh`, `ops/keycloak/set-*.sh` or `ops/local/use-mover-sources.sh` — they are
  for other setups. NEVER write directory or Keycloak settings into `.env` or a compose file: the owner
  enters them on the screen.
- Decisions are recorded in `docs/ARCHITECTURE_DECISIONS.md` (last: ADR-092, next: ADR-093);
  status in `docs/STATUS.md`.

## 2. NEVER (these broke the app before)

1. Never edit, rename or delete an existing migration (V1–V66). A schema change is a NEW file with the next number:
   check `ls backend/src/main/resources/db/migration | sort -V | tail -1`, then create `V67__short_name.sql`.
   Two files with the same version number stop the app from starting. Never UPDATE rows of
   `access_policy_version` whose status is PUBLISHED or SUPERSEDED.
2. Never touch the files in `data/`. Never run `docker compose down -v`, `docker volume rm`, `docker system prune`
   or anything that deletes data. Stop the app (`docker compose stop`) before copying the folder.
3. Never change `docker-compose.yml`, `docker-compose.override.yml`, `start.sh`, `ops/local/workspace/*`
   or the layout of `.env` unless the owner asks for exactly that. Never make a variable mandatory (`${VAR:?}`).
   Never write a machine-specific path (`/media/sf_...`, `/home/...`, `C:\...`) into any file.
4. Never change secrets in `.env` or the files in `ops/local/.generated/` (certificates, LDAP password).
   Never print a password, token or secret in output, logs, docs or reports.
5. No internet: never `docker pull`, `docker build`, `npm install`/`npm ci`, `pip install`, or Maven without `-o`.
   If a new library is truly needed: STOP and tell the owner (it must be packed on a connected machine
   with `sh ops/local/workspace/pack-images.sh`).
6. Never build an image to apply a code change — saving the file is enough.
7. Git: never commit, push, `reset --hard`, `checkout --`, `clean`, `rebase` or force anything unless the owner
   explicitly says so. Never add `data/`, `.env` or `tmrkz-images.tar` to git.
8. Keep the folder clean: no new top-level files or folders, no copies of compose/.env files, no backups,
   no leftovers. Temporary files go in `/tmp` and are deleted when done.
9. Never put real people's names or military numbers in code, tests, docs or screenshots. Use the fictional
   acceptance accounts (`full26.*`).
10. Do only what was asked: no refactoring, reformatting, renaming or "improvements" on the side. Never undo
    the owner's decisions (sign-in logo and layout, Keycloak's standard page, database without password).
11. Scope: administrative stationing, sites and requests only — no military deployment optimisation, tactical
    positioning or operational recommendations.
12. TMRKZ never uses MOVER's database (owner, 23 Nov 2026). Never read, copy, upload or import MOVER's files
    (`transport_requests.db` or any other) or connect to MOVER's database. TMRKZ's units and people come only from its
    own HR source («مصدر الموارد البشرية») and its own directory. Working "like MOVER" means the same way of working,
    never MOVER's data.

## 3. ALWAYS — how to do a task

1. **Understand.** Restate the request in 1–3 lines. If it is unclear, or it conflicts with section 2, ask the owner
   BEFORE changing anything.
2. **Look first.** `git status`; read the files you will change and their tests; `grep` for the existing pattern
   and follow it.
3. **Change the minimum.** Keep the surrounding style. UI text in Arabic. Unix line endings (LF) in `.sh` files.
4. **Watch the rebuild** (section 1) until it succeeds. Fix every `BUILD FAILED` — type errors appear there.
5. **Test what you changed** (offline):
   - Frontend unit tests:
     ```
     docker run --rm --network none --entrypoint sh -v "$PWD/frontend:/src:ro" tmrkz/folder-web:1 -c 'mkdir /w && tar -C /src --exclude=./node_modules --exclude=./dist -cf - . | tar -C /w -xf - && ln -s /modules/node_modules /w/node_modules && cd /w && npx vitest run src/lib/example.test.ts'
     ```
   - Backend tests (they use a throw-away database, never `data/`). Once:
     `docker run --rm --entrypoint true -v tmrkz-m2:/root/.m2 tmrkz/folder-backend:1`
     then: `TMRKZ_TEST_MAVEN_IMAGE=tmrkz/folder-backend:1 TMRKZ_TEST_MAVEN_VOLUME=tmrkz-m2 sh ops/test-backend.sh SomeClassIT`
   - In the browser: `http://<TMRKZ_IP>:<TMRKZ_PORT>`, sign in as `developer`, click through what changed.
6. **Record** a behaviour change: a short ADR with the next number in `docs/ARCHITECTURE_DECISIONS.md`, and one line
   in `docs/STATUS.md`.
7. **Report** to the owner:
   - which files changed;
   - how you checked, with the exact command and result;
   - what you did NOT check;
   - what needs the owner's decision.

   Never say something works unless you saw it work. If a test failed, say so and show the error line.

## 4. STOP and ask the owner when

- the request is unclear or has two possible meanings;
- it needs a new migration that changes or deletes existing data;
- it needs a new library, the internet, or a change to compose files, `.env` or secrets;
- you are about to delete anything;
- a build or test fails and you do not know why after one careful attempt.

## 5. Quick fixes

| Problem | Do |
|---|---|
| page does not open | `docker compose ps`, then `docker compose logs --tail 80 backend web-build web` |
| app stopped | `docker compose up -d` (never `down -v`) |
| sign-in fails | `docker compose logs keycloak-setup` — it must end with `... password client ready` |
| changed `.env` | `docker compose up -d` |

----------------------------------------------------------------------------------------------------
