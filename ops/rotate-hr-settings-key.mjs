#!/usr/bin/env node
// Rotates TMRKZ_HR_SETTINGS_KEY and re-encrypts the stored HR source settings under the new key, so nobody has to re-enter them. Run from
// the repository root, with the backend restarted afterwards (it reads the key at start). No key or setting is ever printed. The new key
// goes to .env, which Git ignores; the old value is not kept anywhere. A backup taken earlier still holds settings under the old key.
//   node ops/rotate-hr-settings-key.mjs
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const DB = process.env.DB_CONTAINER ?? 'tmrkz-mover-db-1';
const NAME = 'TMRKZ_HR_SETTINGS_KEY';
const sql = (script) => execFileSync('docker', ['exec', '-i', DB, 'psql', '-X', '-q', '-U', 'mover', '-d', 'mover', '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
// the same derivation as ae.mover.hr.HrSettingsCipher
const derive = (material) => createHash('sha256').update('tmrkz-hr-settings:' + material, 'utf8').digest();
const keyIdOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16);

const env = readFileSync('.env', 'utf8');
const oldMaterial = env.match(new RegExp(`^${NAME}=(.*)$`, 'm'))?.[1];
if (!oldMaterial) throw new Error(`${NAME} is not in .env`);
const oldKey = derive(oldMaterial);
const row = sql(`select id || '|' || coalesce(settings_key_id, '') || '|' || coalesce(settings_ciphertext, '') from hr_source`);
const rows = row ? row.split('\n') : [];
if (rows.length > 1) throw new Error('more than one HR source: rotate by re-entering them');

let plain = null;
let id = null;
if (rows.length === 1) {
  const [rowId, storedKeyId, token] = rows[0].split('|');
  id = rowId;
  if (token) {
    if (storedKeyId !== keyIdOf(oldKey)) throw new Error('the stored settings are not under the key in .env; nothing changed');
    const all = Buffer.from(token.slice(3), 'base64');
    const d = createDecipheriv('aes-256-gcm', oldKey, all.subarray(0, 12));
    d.setAuthTag(all.subarray(all.length - 16));
    plain = Buffer.concat([d.update(all.subarray(12, all.length - 16)), d.final()]);
  }
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
let material = '';
while (material.length < 48) {
  const b = randomBytes(1)[0];
  if (b < 248) material += alphabet[b % 62];
}
const key = derive(material);
if (keyIdOf(key) === keyIdOf(oldKey)) throw new Error('the new key equals the old one');
const next = env.replace(new RegExp(`^${NAME}=.*$`, 'm'), () => `${NAME}=${material}`);
writeFileSync('.env.rotating', next, { mode: 0o600 });
try {
  if (plain) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    const token = 'v1:' + Buffer.concat([iv, ct]).toString('base64');
    sql(`update hr_source set settings_ciphertext = '${token}', settings_key_id = '${keyIdOf(key)}' where id = '${id}';
insert into audit_event(action, entity_type, entity_id, entity_label, detail, reason) values ('HR_SETTINGS_KEY_ROTATED', 'HR_SOURCE', '${id}', 'hr_source', '{"keyIdChanged": true}'::jsonb, 'تدوير مفتاح حماية إعدادات الموارد البشرية');`);
  }
  renameSync('.env.rotating', '.env');
} catch (e) {
  rmSync('.env.rotating', { force: true });
  throw e;
}
plain?.fill(0);
console.log('HR settings key rotated in .env and the stored settings re-encrypted; restart the backend');
