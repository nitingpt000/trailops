import type { ApiErrorBody } from '@trailops/contracts';
import { config } from '../config';
import { ensureFreshToken, refreshToken } from '../auth/oidc';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fieldErrors: Record<string, string> = {},
    public requestId: string | null = null,
    public retryable = false,
  ) {
    super(message);
  }
}

export const newRequestId = () => `web-${crypto.randomUUID().slice(0, 18)}`;

export type Query = Record<string, string | number | boolean | null | undefined>;

export function buildUrl(path: string, query?: Query): string {
  const url = new URL(path, config.apiBase);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export interface RawResponse {
  status: number;
  body: unknown;
}

/**
 * Low-level request: bearer token, X-Request-Id, one refresh-and-retry on 401.
 * Network failures throw ApiError(0, 'NETWORK').
 */
export async function rawRequest(
  method: string,
  path: string,
  opts: { query?: Query; body?: unknown } = {},
): Promise<RawResponse> {
  const send = async (token: string | null) => {
    const headers: Record<string, string> = { 'X-Request-Id': newRequestId(), Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await fetch(buildUrl(path, opts.query), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Could not reach the TrailOps server. Check your connection and retry.', {}, null, true);
    }
  };
  let res = await send(await ensureFreshToken());
  if (res.status === 401) {
    const u = await refreshToken();
    if (u) res = await send(u.access_token);
  }
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

export function toApiError(status: number, body: unknown): ApiError {
  const env = (body as ApiErrorBody | null)?.error;
  if (env && typeof env === 'object') {
    return new ApiError(status, env.code, env.message, env.field_errors ?? {}, env.request_id, env.retryable);
  }
  if (status === 401) return new ApiError(401, 'UNAUTHENTICATED', 'Your session has expired. Sign in again.');
  return new ApiError(status, `HTTP_${status}`, `Request failed (${status}).`, {}, null, status >= 500);
}

export async function apiGet<T>(path: string, query?: Query): Promise<T> {
  const r = await rawRequest('GET', path, { query });
  if (r.status >= 200 && r.status < 300) return r.body as T;
  throw toApiError(r.status, r.body);
}
