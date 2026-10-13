/**
 * Local WatermelonDB schema (spec §7).
 *
 * Confirmed server projections: every table keeps `server_id` (UUID), `version`, the complete
 * projection in `json`, and a few indexed columns used by queries. They are only ever written by the
 * projection adapter from bootstrap/pull/receipts, never by user actions.
 *
 * Local tables hold intent: the durable command queue, drafts, the attachment queue, sync metadata
 * and user-visible conflicts. Pending work is never stored in projection tables.
 */
import {appSchema, tableSchema, type ColumnSchema} from '@nozbe/watermelondb';

const s = (name: string, indexed = false): ColumnSchema => ({name, type: 'string', isIndexed: indexed});
const so = (name: string, indexed = false): ColumnSchema => ({name, type: 'string', isOptional: true, isIndexed: indexed});
const n = (name: string, indexed = false): ColumnSchema => ({name, type: 'number', isIndexed: indexed});
const no = (name: string): ColumnSchema => ({name, type: 'number', isOptional: true});

const projection = (name: string, extra: ColumnSchema[] = []) =>
  tableSchema({name, columns: [s('server_id', true), n('version'), s('json'), ...extra]});

/** entity type on the wire → local table + indexed columns copied from the projection */
export const PROJECTIONS = {
  camp: {table: 'camps', columns: []},
  location: {table: 'locations', columns: ['camp_id']},
  category: {table: 'categories', columns: ['code']},
  equipment: {table: 'equipment', columns: ['tag', 'status', 'camp_id', 'location_id', 'category_id']},
  batch: {table: 'batches', columns: ['camp_id']},
  batch_member: {table: 'batch_members', columns: ['batch_id', 'trekker_id']},
  allocation: {table: 'allocations', columns: ['item_id', 'state', 'batch_id']},
  inspection: {table: 'inspections', columns: ['item_id']},
  attachment: {table: 'attachments', columns: ['inspection_id']},
  repair: {table: 'repairs', columns: ['item_id', 'state']},
  transfer: {table: 'transfers', columns: ['state', 'to_location_id', 'from_location_id']},
  transfer_line: {table: 'transfer_lines', columns: ['transfer_id', 'item_id']},
  custody_claim: {table: 'custody_claims', columns: ['item_id', 'state']},
  conflict: {table: 'conflicts', columns: ['item_id', 'state', 'operation_id']},
  form_definition: {table: 'form_definitions', columns: ['key']},
  form_version: {table: 'form_versions', columns: ['definition_id', 'status']},
} as const;
export type EntityKey = keyof typeof PROJECTIONS;
export const PROJECTION_TABLES = Object.values(PROJECTIONS).map(p => p.table);

export const schema = appSchema({
  version: 1,
  tables: [
    ...Object.values(PROJECTIONS).map(p => projection(p.table, p.columns.map(c => so(c, true)))),
    tableSchema({
      name: 'command_queue',
      columns: [
        s('operation_id', true), s('account_id', true), s('device_id'), s('type'), so('aggregate_id', true),
        s('payload_json'), s('payload_hash'), no('expected_version'), s('depends_on_json'), s('preconditions_json'),
        s('client_recorded_at'), s('state', true), n('attempts'), no('next_retry_at'), so('result_json'),
        so('error_code'), so('error_message'), s('summary'), n('created_seq'), no('first_sent_at'),
      ],
    }),
    tableSchema({
      name: 'drafts',
      columns: [s('owner_id'), s('screen_key', true), so('entity_id'), so('form_version_id'), s('values_json'), n('saved_at')],
    }),
    tableSchema({
      name: 'attachment_queue',
      columns: [
        s('attachment_id', true), s('operation_id', true), s('inspection_id'), s('private_file_path'), s('hash'),
        s('mime'), n('bytes'), s('state', true), n('attempts'), no('next_retry_at'), so('error'),
      ],
    }),
    tableSchema({
      name: 'sync_meta',
      columns: [
        s('account_id', true), no('scope_epoch'), so('cursor'), so('bootstrap_generation'), n('schema_version'),
        no('last_success_at'), no('last_pull_at'), no('last_push_at'), so('me_json'), no('last_verified_at'),
        so('camp_id'), so('last_error'),
      ],
    }),
    // Deletion tombstones keep stale receipts/events from resurrecting removed entities (spec �18).
    tableSchema({name: 'tombstones', columns: [s('entity'), s('server_id', true), n('version')]}),
    tableSchema({
      name: 'local_conflicts',
      columns: [so('conflict_id', true), s('operation_id', true), s('code'), s('details_json'), s('resolution_state')],
    }),
  ],
});
