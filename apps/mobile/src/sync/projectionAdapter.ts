/**
 * Applies confirmed server state to local projection tables (spec §7, §18).
 *
 * This is the custom command-and-projection adapter: it never calls WatermelonDB's synchronize()
 * and never touches the command queue. Each call runs inside the caller's database.write() so a
 * pull page and its cursor commit atomically.
 */
import {Q, type Database, type Model} from '@nozbe/watermelondb';
import type {ChangeEvent, EntityType} from '@trailops/contracts';
import type {LocalRecord, ProjectionRecord} from '../database/models';
import {PROJECTIONS, PROJECTION_TABLES, type EntityKey} from '../database/schema';

type Incoming = {entity: string; id: string; version: number; deleted?: boolean; data: unknown};

function rawFor(entity: EntityKey, id: string, version: number, data: Record<string, unknown>) {
  const raw: Record<string, unknown> = {server_id: id, version, json: JSON.stringify(data)};
  for (const c of PROJECTIONS[entity].columns) {
    const v = data[c];
    raw[c] = v === undefined || v === null ? null : String(v);
  }
  return raw;
}

/**
 * Upserts/deletes a set of events. Older versions are ignored; tombstones block resurrection.
 * Must be called inside db.write().
 */
export async function applyEvents(db: Database, events: Incoming[]): Promise<number> {
  const byEntity = new Map<EntityKey, Incoming[]>();
  for (const e of events) {
    if (!(e.entity in PROJECTIONS)) continue; // unknown entity from a newer server: skip safely
    const k = e.entity as EntityKey;
    byEntity.set(k, [...(byEntity.get(k) ?? []), e]);
  }
  const ops: Model[] = [];
  let applied = 0;
  for (const [entity, all] of byEntity) {
    // A page may carry several events for one entity; only the newest matters, and WatermelonDB
    // cannot prepare two updates of the same record in one batch.
    const newest = new Map<string, Incoming>();
    for (const e of all) {
      const prev = newest.get(e.id);
      if (!prev || e.version >= prev.version) newest.set(e.id, e);
    }
    const list = [...newest.values()];
    const table = PROJECTIONS[entity].table;
    const ids = [...new Set(list.map(e => e.id))];
    const existing = new Map(
      (await db.get<ProjectionRecord>(table).query(Q.where('server_id', Q.oneOf(ids))).fetch()).map(r => [r.serverId, r]),
    );
    const tombs = new Map(
      (await db.get<LocalRecord<{entity: string; server_id: string; version: number}>>('tombstones')
        .query(Q.where('server_id', Q.oneOf(ids))).fetch())
        .filter(t => t.r.entity === entity)
        .map(t => [t.r.server_id, t]),
    );
    for (const e of list) {
      const row = existing.get(e.id);
      const tomb = tombs.get(e.id);
      if (row && row.version > e.version) continue;
      if (tomb && tomb.r.version >= e.version && !e.deleted) continue;
      if (e.deleted || e.data == null) {
        if (row) {
          ops.push(row.prepareDestroyPermanently());
          existing.delete(e.id);
        }
        if (tomb) {
          ops.push(tomb.prepareUpdate(t => t.set({version: Math.max(t.r.version, e.version)})));
        } else {
          const created = db.get<LocalRecord>('tombstones').prepareCreate(t => {
            Object.assign(t._raw, {entity, server_id: e.id, version: e.version});
          });
          ops.push(created);
          tombs.set(e.id, created as unknown as LocalRecord<{entity: string; server_id: string; version: number}>);
        }
        applied++;
        continue;
      }
      const raw = rawFor(entity, e.id, e.version, e.data as Record<string, unknown>);
      if (tomb) {
        // A newer live version than the tombstone (moved back into scope): forget the tombstone.
        ops.push(tomb.prepareDestroyPermanently());
        tombs.delete(e.id);
      }
      if (row) {
        ops.push(row.prepareUpdate(r => {
          for (const [k, v] of Object.entries(raw)) (r as unknown as {_setRaw: (k: string, v: unknown) => void})._setRaw(k, v);
        }));
      } else {
        const created = db.get<ProjectionRecord>(table).prepareCreate(r => {
          Object.assign(r._raw, raw);
        });
        ops.push(created);
        existing.set(e.id, created);
      }
      applied++;
    }
  }
  if (ops.length) await db.batch(ops);
  return applied;
}

/** Replace all confirmed projections with a staged snapshot. Queue, drafts and files are untouched. */
export async function replaceSnapshot(
  db: Database, records: Partial<Record<EntityType, {id: string; version?: number}[]>>,
): Promise<number> {
  const deletes: Model[] = [];
  for (const table of [...PROJECTION_TABLES, 'tombstones']) {
    const rows = await db.get(table).query().fetch();
    for (const r of rows) deletes.push(r.prepareDestroyPermanently());
  }
  if (deletes.length) await db.batch(deletes);
  const events: Incoming[] = [];
  for (const [entity, rows] of Object.entries(records)) {
    for (const row of rows ?? []) {
      events.push({entity, id: row.id, version: (row.version as number | undefined) ?? 1, data: row});
    }
  }
  return applyEvents(db, events);
}

export function changeToIncoming(c: ChangeEvent): Incoming {
  return {entity: c.entity, id: c.id, version: c.version, deleted: c.deleted, data: c.data};
}
