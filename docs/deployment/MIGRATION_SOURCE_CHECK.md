# Telling what a migration source file is (owner brief, 20 Nov 2026)

The older installation on the VM hands over a file (reported as `db.db`). TMRKZ migrates **only PostgreSQL**: a live
connection or a `pg_dump -Fc` archive («مركز ترحيل قاعدة البيانات», ADR-094 step 3). Before anything else, say what the file is;
run these on the machine that holds it (none of them changes the file):

```sh
file db.db                      # "PostgreSQL custom database dump" → pg_dump -Fc archive; "SQLite 3.x database" → SQLite; "ASCII text" → maybe plain SQL
head -c 16 db.db | od -c        # SQLite starts with "SQLite format 3\0"; a custom dump starts with "PGDMP"
pg_restore -l db.db | head -20  # lists the archive's table of contents when it is a pg_dump custom archive; errors otherwise
```

| Result | What to do |
|---|---|
| `PGDMP` / `pg_restore -l` lists tables | Copy it into the migration inbox and use «ملف نسخة احتياطية» in the migration center. |
| `SQLite format 3` | Not supported by the migration center. Export the tables to CSV and use «استيراد الهيكل التنظيمي» for the units; people and accounts come from the directory and HR on demand (ADR-094). Say so in the handoff instead of guessing. |
| plain SQL (`CREATE TABLE …`) | Restore it into a scratch PostgreSQL first (`psql -f`), then `pg_dump -Fc` that database and use the archive. |

Never run `pg_restore` against the live TMRKZ database; the center restores into an isolated staging database only.
