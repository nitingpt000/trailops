import type {ApiErrorBody} from '@trailops/contracts';
import {config} from '../app/config';
import {accessToken} from '../auth/session';
import {uuid} from '../native/sha256';

export class NetworkError extends Error {}
export class HttpError extends Error {
  constructor(public status: number, public body: ApiErrorBody | null) {
    super(body?.error?.message ?? `HTTP ${status}`);
  }
  get code(): string | undefined {
    return this.body?.error?.code;
  }
}

export interface ApiContext {
  accountId: string;
  deviceId?: string | null;
}

const TIMEOUT_MS = 20_000;

/** Authenticated JSON request with one forced credential refresh on 401 (spec §18 outcome table). */
export async function api<T>(ctx: ApiContext, method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const token = await accessToken(ctx.accountId, retried);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(config.apiBase + path, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Request-Id': `req-${uuid().slice(0, 12)}`,
        ...(ctx.deviceId ? {'X-Device-Id': ctx.deviceId} : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new NetworkError('Network unavailable');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 && !retried) return api<T>(ctx, method, path, body, true);
  const text = await res.text();
  const parsed = text ? safeJson(text) : null;
  if (!res.ok) throw new HttpError(res.status, parsed as ApiErrorBody | null);
  return parsed as T;
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}
