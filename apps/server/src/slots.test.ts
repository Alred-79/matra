import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import request from 'supertest';
import { encryptJSON, generateContentKey, openSlot, sealSlot, slotName, wrapKeyWithMaster } from '@matra/crypto';
import { SLOT_MAX_PER_ACCOUNT, parseDraftMode } from '@matra/shared';
import { createApp, getDb, getSlots } from './app.js';
import { draftsDbPathFor } from './slots.js';
import { TEST_PEPPER, createRecord, makeApp, registerUser, type TestUser } from './test-helpers.js';

const count = (db: ReturnType<typeof makeApp>['db'], sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

async function put(app: Parameters<typeof request>[0], u: TestUser, label: string, value: unknown, expectedSeq: number) {
  const name = await slotName(u.masterKey, label);
  return request(app).put(`/api/vault/slots/${name}`).set(u.auth).send({ ...(await sealSlot(value, u.masterKey)), expectedSeq });
}

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matra-slots-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('draft slots', () => {
  it('ten autosaves write no record, no ledger entry and no activity row; she reads back the newest', async () => {
    const { app, db } = makeApp();
    const jane = await registerUser(app, 'jane.slot');
    const before = { records: count(db, 'SELECT COUNT(*) n FROM records'), ledger: count(db, 'SELECT COUNT(*) n FROM ledger'), audit: count(db, 'SELECT COUNT(*) n FROM audit_events WHERE user_id = ?', jane.user.id) };
    for (let i = 0; i < 10; i++) {
      const res = await put(app, jane, 'draft', { kind: 'draft', words: `version ${i}` }, i);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ seq: i + 1, updatedDay: new Date().toISOString().slice(0, 10), draftMode: 'slot' });
    }
    expect(count(db, 'SELECT COUNT(*) n FROM records')).toBe(before.records);
    expect(count(db, 'SELECT COUNT(*) n FROM ledger')).toBe(before.ledger);
    expect(count(db, 'SELECT COUNT(*) n FROM audit_events WHERE user_id = ?', jane.user.id)).toBe(before.audit);

    const name = await slotName(jane.masterKey, 'draft');
    const got = await request(app).get(`/api/vault/slots/${name}`).set(jane.auth);
    expect(got.status).toBe(200);
    expect(got.body.draftMode).toBe('slot');
    expect(got.body.slot).toMatchObject({ name, seq: 10 });
    expect(await openSlot(got.body.slot, jane.masterKey)).toEqual({ kind: 'draft', words: 'version 9' });
    // one row, overwritten in place; its only time is the UTC day
    const rows = getSlots(app).db.prepare('SELECT * FROM slots').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(['envelope', 'name', 'owner_id', 'seq', 'updated_day', 'wrapped_key']);
    expect(rows[0]!.updated_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a stale seq gets 409 slot_conflict and changes nothing (another device saved first)', async () => {
    const { app } = makeApp();
    const jane = await registerUser(app, 'jane.cas');
    expect((await put(app, jane, 'draft', { from: 'laptop' }, 0)).status).toBe(200);
    // her phone opened the draft at seq 1 too; the laptop saves again first
    expect((await put(app, jane, 'draft', { from: 'laptop, later' }, 1)).status).toBe(200);
    const stale = await put(app, jane, 'draft', { from: 'phone' }, 1);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('slot_conflict');
    // creating over an existing slot is a conflict too
    expect((await put(app, jane, 'draft', { from: 'new device' }, 0)).body.code).toBe('slot_conflict');
    const name = await slotName(jane.masterKey, 'draft');
    const got = await request(app).get(`/api/vault/slots/${name}`).set(jane.auth);
    expect(got.body.slot.seq).toBe(2);
    expect(await openSlot(got.body.slot, jane.masterKey)).toEqual({ from: 'laptop, later' });
  });

  it('refuses ciphertext that is not whole 16 KiB buckets, names that are not 64 hex, and other roles', async () => {
    const { app } = makeApp({ autoVerifyAttorneys: true });
    const jane = await registerUser(app, 'jane.pad');
    const name = await slotName(jane.masterKey, 'draft');
    const key = await generateContentKey();
    const unpadded = { envelope: await encryptJSON({ words: 'short' }, key), wrappedKey: await wrapKeyWithMaster(key, jane.masterKey), expectedSeq: 0 };
    const res = await request(app).put(`/api/vault/slots/${name}`).set(jane.auth).send(unpadded);
    expect(res.status).toBe(400);
    expect((await request(app).put('/api/vault/slots/draft').set(jane.auth).send({ ...(await sealSlot({}, jane.masterKey)), expectedSeq: 0 })).status).toBe(400);
    expect((await request(app).get(`/api/vault/slots/${name.toUpperCase()}`).set(jane.auth)).status).toBe(400);
    const atty = await registerUser(app, 'atty.slot', 'attorney');
    expect((await request(app).get(`/api/vault/slots/${name}`).set(atty.auth)).status).toBe(403);
    expect((await request(app).get(`/api/vault/slots/${name}`)).status).toBe(401);
  });

  it('slots are per account: the same name under another account is a different slot', async () => {
    const { app } = makeApp();
    const jane = await registerUser(app, 'jane.own');
    const sam = await registerUser(app, 'sam.own');
    await put(app, jane, 'draft', { mine: true }, 0);
    const janeName = await slotName(jane.masterKey, 'draft');
    expect(await slotName(sam.masterKey, 'draft')).not.toBe(janeName);
    // even if Sam asks for Jane's opaque name, he only ever reaches his own (empty) slot
    expect((await request(app).get(`/api/vault/slots/${janeName}`).set(sam.auth)).body.slot).toBeNull();
    expect((await request(app).delete(`/api/vault/slots/${janeName}`).set(sam.auth)).status).toBe(200);
    expect((await request(app).get(`/api/vault/slots/${janeName}`).set(jane.auth)).body.slot.seq).toBe(1);
  });

  it('caps the number of slots per account', async () => {
    const { app } = makeApp();
    const jane = await registerUser(app, 'jane.cap');
    for (let i = 0; i < SLOT_MAX_PER_ACCOUNT; i++) expect((await put(app, jane, `slot-${i}`, { i }, 0)).status).toBe(200);
    const over = await put(app, jane, 'one-too-many', {}, 0);
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('too_many_slots');
  });

  it('deleting a slot clears it and leaves nothing in the WAL; a stale delete is refused', async () => {
    const dir = tmpDir();
    const { app } = makeApp({ dbPath: path.join(dir, 'matra.db') });
    const wal = path.join(dir, 'matra-drafts.db-wal');
    const jane = await registerUser(app, 'jane.del');
    await put(app, jane, 'draft', { words: 'first' }, 0);
    await put(app, jane, 'draft', { words: 'second' }, 1);
    // every write is checkpointed out of the WAL, so no earlier version waits there
    expect(fs.statSync(wal).size).toBe(0);
    const name = await slotName(jane.masterKey, 'draft');
    expect((await request(app).delete(`/api/vault/slots/${name}`).set(jane.auth).send({ expectedSeq: 1 })).body.code).toBe('slot_conflict');
    expect((await request(app).delete(`/api/vault/slots/${name}`).set(jane.auth).send({ expectedSeq: 2 })).body).toEqual({ ok: true });
    expect((await request(app).get(`/api/vault/slots/${name}`).set(jane.auth)).body.slot).toBeNull();
    expect(fs.statSync(wal).size).toBe(0);
    const onDisk = fs.readFileSync(path.join(dir, 'matra-drafts.db'));
    expect(onDisk.includes(Buffer.from(name))).toBe(false);
  });

  it('account deletion deletes her slots (and empties the drafts WAL); other accounts keep theirs', async () => {
    const dir = tmpDir();
    const { app } = makeApp({ dbPath: path.join(dir, 'matra.db') });
    const jane = await registerUser(app, 'jane.gone');
    const sam = await registerUser(app, 'sam.stays');
    await put(app, jane, 'draft', { words: 'hers' }, 0);
    await put(app, jane, 'casecard', { words: 'hers too' }, 0);
    await put(app, sam, 'draft', { words: 'his' }, 0);
    const del = await request(app).post('/api/account/delete').set(jane.auth).send({ authKey: jane.authKey });
    expect(del.status).toBe(200);
    const slots = getSlots(app).db;
    expect(count(slots, 'SELECT COUNT(*) n FROM slots WHERE owner_id = ?', jane.user.id)).toBe(0);
    expect(count(slots, 'SELECT COUNT(*) n FROM slots WHERE owner_id = ?', sam.user.id)).toBe(1);
    expect(fs.statSync(path.join(dir, 'matra-drafts.db-wal')).size).toBe(0);
  });

  it('on start, removes slots whose account is gone (a deletion that stopped between the two files)', async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'matra.db');
    const first = makeApp({ dbPath });
    const jane = await registerUser(first.app, 'jane.orphan');
    await put(first.app, jane, 'draft', { words: 'hers' }, 0);
    getSlots(first.app).db.prepare(`INSERT INTO slots VALUES ('${'f'.repeat(32)}', '${'a'.repeat(64)}', '{}', '{}', 1, '2026-01-01')`).run();
    first.db.close();
    getSlots(first.app).db.close();
    const again = makeApp({ dbPath });
    expect(count(getSlots(again.app).db, 'SELECT COUNT(*) n FROM slots')).toBe(1);
    expect(count(getSlots(again.app).db, 'SELECT COUNT(*) n FROM slots WHERE owner_id = ?', jane.user.id)).toBe(1);
  });

  it('MATRA_DRAFT_MODE=keep-versions also files every save as a record with a ledger entry', async () => {
    const app = createApp({ dbPath: ':memory:', pepper: TEST_PEPPER, draftMode: 'keep-versions' });
    const db = getDb(app);
    const jane = await registerUser(app, 'jane.keep');
    const ledger0 = count(db, 'SELECT COUNT(*) n FROM ledger');
    for (let i = 0; i < 3; i++) expect((await put(app, jane, 'draft', { kind: 'draft', words: `v${i}` }, i)).body.draftMode).toBe('keep-versions');
    // a stale write keeps nothing
    expect((await put(app, jane, 'draft', { kind: 'draft', words: 'stale' }, 1)).status).toBe(409);
    expect(count(db, 'SELECT COUNT(*) n FROM records WHERE owner_id = ?', jane.user.id)).toBe(3);
    expect(count(db, 'SELECT COUNT(*) n FROM ledger')).toBe(ledger0 + 3);
    const list = (await request(app).get('/api/vault/records').set(jane.auth)).body.records as Array<{ id: string }>;
    const opened = await Promise.all(
      list.map(async (r) => {
        const { record } = (await request(app).get(`/api/vault/records/${r.id}`).set(jane.auth)).body;
        return openSlot<{ words: string }>({ envelope: record.envelope, wrappedKey: record.ownerWrappedKey }, jane.masterKey);
      }),
    );
    expect(opened.map((o) => o.words)).toEqual(['v0', 'v1', 'v2']);
    expect((await request(app).get(`/api/vault/slots/${await slotName(jane.masterKey, 'draft')}`).set(jane.auth)).body.draftMode).toBe('keep-versions');
    // sealed records still work alongside
    expect((await createRecord(app, jane)).res.status).toBe(201);
  });

  it('MATRA_DRAFT_MODE: slot by default, keep-versions on request, anything else refused', () => {
    expect(parseDraftMode(undefined)).toBe('slot');
    expect(parseDraftMode('')).toBe('slot');
    expect(parseDraftMode(' Keep-Versions ')).toBe('keep-versions');
    expect(() => parseDraftMode('versions')).toThrow(/MATRA_DRAFT_MODE/);
    expect(draftsDbPathFor('/data/matra.db')).toBe('/data/matra-drafts.db');
    expect(draftsDbPathFor(':memory:')).toBe(':memory:');
  });
});
