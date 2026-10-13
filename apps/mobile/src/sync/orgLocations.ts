/**
 * Location labels for the whole organisation (destinations and other camps' stores). They are not
 * part of the camp-scoped download, so each successful sync caches GET /v1/locations locally.
 * Labels only: no inventory or people.
 */
import {Q, type Database} from '@nozbe/watermelondb';
import type {DraftRow, LocalRecord} from '../database/models';
import {api, type ApiContext} from './api';

export interface OrgLocation {
  id: string;
  label: string;
  camp_id: string;
  camp_name: string;
}

export const ORG_LOCATIONS_KEY = 'cache:org-locations';

export async function refreshOrgLocations(db: Database, ctx: ApiContext): Promise<OrgLocation[]> {
  const r = await api<{items: OrgLocation[]}>(ctx, 'GET', '/v1/locations');
  const rows = await db.get<LocalRecord<DraftRow>>('drafts').query(Q.where('screen_key', ORG_LOCATIONS_KEY)).fetch();
  await db.write(async () => {
    if (rows[0]) await rows[0].update(d => d.set({values_json: JSON.stringify(r.items), saved_at: Date.now()}));
    else
      await db.get<LocalRecord<DraftRow>>('drafts').create(d => {
        Object.assign(d._raw, {
          owner_id: ctx.accountId, screen_key: ORG_LOCATIONS_KEY, entity_id: null, form_version_id: null,
          values_json: JSON.stringify(r.items), saved_at: Date.now(),
        });
      });
  });
  return r.items;
}
