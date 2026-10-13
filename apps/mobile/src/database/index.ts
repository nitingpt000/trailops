/**
 * Per-account databases (spec §4: never mix one user's queue with another user's session).
 * Each signed-in account gets its own SQLite file; switching account closes the previous one.
 */
import {Database, Q} from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import {schemaMigrations} from '@nozbe/watermelondb/Schema/migrations';
import {modelClasses, type LocalRecord, type SyncMetaRow} from './models';
import {schema} from './schema';

// Future schema versions add steps here; migrations must preserve queue and attachment rows (MIG-01).
export const migrations = schemaMigrations({migrations: []});

let current: {accountId: string; db: Database} | null = null;

export function dbNameFor(accountId: string): string {
  return `trailops_${accountId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`;
}

export function openDatabase(accountId: string, adapterOverride?: unknown): Database {
  if (current?.accountId === accountId) return current.db;
  const adapter =
    adapterOverride ??
    new SQLiteAdapter({
      schema,
      migrations,
      dbName: dbNameFor(accountId),
      // Async bridge adapter: WatermelonDB's JSI installer needs extra native wiring that was not
      // part of the M0 compatibility gate. See docs/compatibility.md.
      jsi: false,
      onSetUpError: error => {
        // Surface as a recoverable diagnostic; never delete the database here (spec §9).
        lastSetupError = error;
      },
    });
  const db = new Database({adapter: adapter as never, modelClasses});
  current = {accountId, db};
  return db;
}

export let lastSetupError: Error | null = null;

export function currentDatabase(): Database {
  if (!current) throw new Error('No account database is open');
  return current.db;
}

export function closeDatabase(): void {
  current = null;
}

export async function getMeta(db: Database, accountId: string): Promise<LocalRecord<SyncMetaRow>> {
  const rows = await db.get<LocalRecord<SyncMetaRow>>('sync_meta').query(Q.where('account_id', accountId)).fetch();
  if (rows[0]) return rows[0];
  return db.write(() =>
    db.get<LocalRecord<SyncMetaRow>>('sync_meta').create(r => {
      Object.assign(r._raw, {
        account_id: accountId, scope_epoch: null, cursor: null, bootstrap_generation: null, schema_version: 1,
        last_success_at: null, last_pull_at: null, last_push_at: null, me_json: null, last_verified_at: null,
        camp_id: null, last_error: null,
      });
    }),
  );
}
