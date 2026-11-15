/**
 * Draft slots (packages/shared/src/slots.ts): one encrypted, overwritable envelope per (account, opaque name), in their
 * own SQLite file next to the main database. Not ledgered, no WORM triggers, no audit rows: autosaving a draft must not
 * mint a permanent record (MATRA_DRAFT_MODE=keep-versions files a copy as a record in app.ts, which is the only way a
 * draft reaches the main database).
 *
 * What the server learns about a slot: which account, an opaque 64-hex name, the ciphertext size to the nearest 16 KiB,
 * how many times it has been written (seq), and the UTC day of the last write. No creation time, no finer time.
 *
 * Overwritten and deleted ciphertext: secure_delete overwrites freed pages, and every write ends with a TRUNCATE
 * checkpoint (journal_size_limit 0), so the WAL holds no earlier version once a write returns. Copies in freed
 * filesystem blocks, snapshots or backups are outside SQLite's reach (docs/SECURITY_WHITEPAPER.md §4b).
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';

export interface SlotRow {
  owner_id: string;
  name: string;
  envelope: string;
  wrapped_key: string;
  seq: number;
  updated_day: string;
}

export type PutResult = { ok: true; seq: number; updatedDay: string } | { ok: false; reason: 'conflict'; seq: number } | { ok: false; reason: 'full' };

/** Where the slots live for a main database at `dbPath`: `<name>-drafts.db` beside it (':memory:' stays in memory). */
export function draftsDbPathFor(dbPath: string): string {
  if (dbPath === ':memory:') return ':memory:';
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath).replace(/\.(db|sqlite3?)$/i, '');
  return path.join(dir, `${base}-drafts.db`);
}

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

const statements = (db: DB) => ({
  get: db.prepare('SELECT * FROM slots WHERE owner_id = ? AND name = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM slots WHERE owner_id = ?'),
  insert: db.prepare('INSERT INTO slots (owner_id, name, envelope, wrapped_key, seq, updated_day) VALUES (?, ?, ?, ?, 1, ?)'),
  update: db.prepare('UPDATE slots SET envelope = ?, wrapped_key = ?, seq = seq + 1, updated_day = ? WHERE owner_id = ? AND name = ? AND seq = ?'),
  delete: db.prepare('DELETE FROM slots WHERE owner_id = ? AND name = ?'),
  deleteOwner: db.prepare('DELETE FROM slots WHERE owner_id = ?'),
  owners: db.prepare('SELECT DISTINCT owner_id FROM slots'),
});

export class SlotStore {
  readonly db: DB;
  private readonly q: ReturnType<typeof statements>;

  constructor(dbPath: string, private readonly maxPerAccount: number) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('secure_delete = ON');
    this.db.pragma('journal_size_limit = 0');
    this.db.exec(`CREATE TABLE IF NOT EXISTS slots (
      owner_id    TEXT NOT NULL,
      name        TEXT NOT NULL,              -- hex HMAC under her slot-name key; opaque to the server
      envelope    TEXT NOT NULL,              -- Envelope JSON, ciphertext padded to whole 16 KiB buckets
      wrapped_key TEXT NOT NULL,              -- WrappedKey JSON, under her master key
      seq         INTEGER NOT NULL,           -- writes so far; compare-and-swap
      updated_day TEXT NOT NULL,              -- UTC day of the last write, nothing finer
      PRIMARY KEY (owner_id, name)
    ) WITHOUT ROWID`);
    this.q = statements(this.db);
  }

  get(ownerId: string, name: string): SlotRow | undefined {
    return this.q.get.get(ownerId, name) as SlotRow | undefined;
  }

  /** Whether she can make one more slot. */
  hasRoom(ownerId: string): boolean {
    return (this.q.count.get(ownerId) as { n: number }).n < this.maxPerAccount;
  }

  /** Current seq of a slot (0 when there is none). */
  seqOf(ownerId: string, name: string): number {
    return this.get(ownerId, name)?.seq ?? 0;
  }

  /**
   * Write if `expectedSeq` is the slot's current seq (0 = she has none yet). Synchronous, so nothing else runs between
   * the check and the write.
   */
  put(ownerId: string, name: string, envelope: string, wrappedKey: string, expectedSeq: number): PutResult {
    const day = utcDay();
    const result = this.db.transaction((): PutResult => {
      const cur = this.get(ownerId, name);
      if ((cur?.seq ?? 0) !== expectedSeq) return { ok: false, reason: 'conflict', seq: cur?.seq ?? 0 };
      if (!cur) {
        if (!this.hasRoom(ownerId)) return { ok: false, reason: 'full' };
        this.q.insert.run(ownerId, name, envelope, wrappedKey, day);
        return { ok: true, seq: 1, updatedDay: day };
      }
      this.q.update.run(envelope, wrappedKey, day, ownerId, name, expectedSeq);
      return { ok: true, seq: cur.seq + 1, updatedDay: day };
    })();
    if (result.ok) this.checkpoint();
    return result;
  }

  /** Delete one slot if `expectedSeq` (when given) is current. */
  delete(ownerId: string, name: string, expectedSeq?: number): { ok: boolean } {
    const cur = this.get(ownerId, name);
    if (expectedSeq !== undefined && (cur?.seq ?? 0) !== expectedSeq) return { ok: false };
    if (cur) {
      this.q.delete.run(ownerId, name);
      this.checkpoint();
    }
    return { ok: true };
  }

  /** Account deletion: every slot she has. */
  deleteOwner(ownerId: string): void {
    this.q.deleteOwner.run(ownerId);
    this.checkpoint();
  }

  /**
   * Slots whose account no longer exists (an account deletion that stopped between the main database and this one):
   * deleted at startup.
   */
  sweepOrphans(accountExists: (ownerId: string) => boolean): number {
    const gone = (this.q.owners.all() as Array<{ owner_id: string }>).map((r) => r.owner_id).filter((id) => !accountExists(id));
    for (const id of gone) this.q.deleteOwner.run(id);
    if (gone.length) this.checkpoint();
    return gone.length;
  }

  /** Move written pages out of the WAL and truncate it, so no earlier version waits there for a later checkpoint. */
  checkpoint(): void {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // best effort: a busy checkpoint leaves the frames for the next write's checkpoint
    }
  }
}
