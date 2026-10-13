/**
 * Evidence capture + upload (spec §14, §20). Photos are copied into app-private storage and hashed
 * before the command is queued, so the queue never points at a temporary camera path. Local files
 * are deleted only after the server reports VERIFIED.
 */
import {Q, type Database} from '@nozbe/watermelondb';
import ReactNativeBlobUtil from 'react-native-blob-util';
import {retryDelayMs, type AttachmentDescriptor} from '@trailops/contracts';
import type {AttachmentRow, LocalRecord} from '../database/models';
import {uuid} from '../native/sha256';
import {HttpError, NetworkError, api, type ApiContext} from './api';

const EVIDENCE_DIR = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/evidence`;

export interface CapturedPhoto {
  attachment_id: string;
  path: string;
  sha256: string;
  bytes: number;
  mime: 'image/jpeg';
}

/** Copy a camera file into private storage and hash it. Throws if the write fails (shown separately). */
export async function persistPhoto(tempPath: string): Promise<CapturedPhoto> {
  const fs = ReactNativeBlobUtil.fs;
  if (!(await fs.isDir(EVIDENCE_DIR))) await fs.mkdir(EVIDENCE_DIR);
  const id = uuid();
  const dest = `${EVIDENCE_DIR}/${id}.jpg`;
  const src = tempPath.replace(/^file:\/\//, '');
  await fs.cp(src, dest);
  const stat = await fs.stat(dest);
  const sha256 = await fs.hash(dest, 'sha256');
  return {attachment_id: id, path: dest, sha256, bytes: Number(stat.size), mime: 'image/jpeg'};
}

export async function discardPhoto(p: CapturedPhoto): Promise<void> {
  await ReactNativeBlobUtil.fs.unlink(p.path).catch(() => undefined);
}

export function descriptor(p: CapturedPhoto): AttachmentDescriptor {
  return {attachment_id: p.attachment_id, sha256: p.sha256, mime: p.mime, bytes: p.bytes};
}

export function prepareAttachmentRows(db: Database, operationId: string, inspectionId: string, photos: CapturedPhoto[]) {
  return photos.map(p =>
    db.get<LocalRecord<AttachmentRow>>('attachment_queue').prepareCreate(r => {
      const raw: AttachmentRow = {
        attachment_id: p.attachment_id, operation_id: operationId, inspection_id: inspectionId,
        private_file_path: p.path, hash: p.sha256, mime: p.mime, bytes: p.bytes, state: 'WAITING_PARENT',
        attempts: 0, next_retry_at: null, error: null,
      };
      Object.assign(r._raw, raw);
    }),
  );
}

export async function uploadReadyAttachments(db: Database, ctx: ApiContext): Promise<void> {
  const now = Date.now();
  const rows = (await db.get<LocalRecord<AttachmentRow>>('attachment_queue')
    .query(Q.where('state', Q.oneOf(['READY_UPLOAD', 'UPLOADING', 'VERIFYING']))).fetch())
    .filter(r => !r.r.next_retry_at || r.r.next_retry_at <= now);
  for (const row of rows) {
    const set = (v: Partial<AttachmentRow>) => db.write(() => row.update(x => x.set(v)));
    try {
      if (row.r.state !== 'VERIFYING') {
        await set({state: 'UPLOADING', attempts: row.r.attempts + 1});
        const slot = await api<{state: string; upload_url: string | null; headers?: Record<string, string>}>(
          ctx, 'POST', `/v1/attachments/${row.r.attachment_id}/initiate`);
        if (slot.upload_url) {
          // Signed URLs are never logged (spec §20).
          const res = await ReactNativeBlobUtil.fetch('PUT', slot.upload_url, slot.headers ?? {'Content-Type': row.r.mime},
            ReactNativeBlobUtil.wrap(row.r.private_file_path));
          const status = res.info().status;
          if (status >= 300) throw new HttpError(status, null);
        }
        await set({state: 'VERIFYING'});
      }
      const done = await api<{state: 'VERIFIED' | 'REJECTED'; reason: string | null}>(
        ctx, 'POST', `/v1/attachments/${row.r.attachment_id}/complete`);
      await set({state: done.state, error: done.reason, next_retry_at: null});
      if (done.state === 'VERIFIED') {
        await ReactNativeBlobUtil.fs.unlink(row.r.private_file_path).catch(() => undefined);
      }
    } catch (e) {
      const retryable = e instanceof NetworkError || (e instanceof HttpError && (e.status >= 500 || e.body?.error?.retryable));
      await set(retryable || !(e instanceof HttpError)
        ? {state: 'READY_UPLOAD', next_retry_at: Date.now() + retryDelayMs(row.r.attempts), error: 'Will retry upload'}
        : {state: 'REJECTED', error: e.body?.error?.message ?? `Upload failed (${e.status})`});
      if (e instanceof NetworkError) throw e;
    }
  }
}
