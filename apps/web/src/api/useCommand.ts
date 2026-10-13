import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CommandType, Operation, Receipt } from '@trailops/contracts';
import { ApiError, rawRequest, toApiError } from './client';
import {
  describeReceipt,
  isReceipt,
  isTerminal,
  prepareOperation,
  type Attempt,
  type CommandDraft,
  type ReceiptView,
} from './commands';
import { useToast } from '../ui/Toast';

/** POST one operation. Receipts come back for 200 / 409 / 422 / 403 / 503. */
export async function postCommand(op: Operation): Promise<Receipt> {
  const r = await rawRequest('POST', '/v1/commands', { body: op });
  if (isReceipt(r.body)) return { ...r.body, http_status: r.body.http_status ?? r.status };
  throw toApiError(r.status, r.body);
}

const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

export interface UseCommandOptions {
  /** Toast text on acceptance. */
  success?: string | ((r: Receipt) => string);
  onAccepted?: (r: Receipt) => void;
}

/**
 * Submission hook: prevents double submit, keeps one operation id per submission (reused on retry),
 * maps receipts to messages and refetches server projections after every terminal receipt.
 */
export function useCommand(options: UseCommandOptions = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  const attempt = useRef<Attempt | null>(null);
  const inflight = useRef(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<ReceiptView | null>(null);
  const optsRef = useRef(options);
  optsRef.current = options;

  const submit = useCallback(
    async <T extends CommandType>(draft: CommandDraft<T>): Promise<Receipt | null> => {
      if (inflight.current) return null;
      inflight.current = true;
      setPending(true);
      setOutcome(null);
      const op = prepareOperation(draft, attempt.current);
      attempt.current = { operation: op, settled: false };
      try {
        let receipt: Receipt | null = null;
        // Automatic retry of transient outcomes with the SAME operation id (server dedupes).
        for (let i = 0; i < 3; i++) {
          try {
            receipt = await postCommand(op);
            if (receipt.status !== 'RETRY') break;
          } catch (e) {
            if (!(e instanceof ApiError) || !(e.code === 'NETWORK' || e.status >= 500) || i === 2) throw e;
          }
          await wait(600 * (i + 1));
        }
        if (!receipt) throw new ApiError(0, 'NETWORK', 'No response from the server.');
        if (isTerminal(receipt)) attempt.current = { operation: op, settled: true };
        const view = describeReceipt(receipt);
        setOutcome(view);
        if (receipt.status === 'ACCEPTED') {
          const s = optsRef.current.success;
          toast({ tone: 'success', title: typeof s === 'function' ? s(receipt) : s ?? 'Saved', message: receipt.replayed ? view.message : undefined });
          optsRef.current.onAccepted?.(receipt);
        } else if (receipt.status === 'CONFLICT' || receipt.status === 'REJECTED') {
          toast({ tone: view.tone, title: view.title, message: view.message });
        }
        if (isTerminal(receipt)) await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
        return receipt;
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', String(e));
        // Envelope-level 4xx (e.g. malformed operation) is terminal; network/5xx keeps the id for retry.
        if (err.status >= 400 && err.status < 500) attempt.current = { operation: op, settled: true };
        const view: ReceiptView = {
          tone: 'error',
          title: err.code === 'NETWORK' ? 'Not sent' : 'Request failed',
          message:
            err.code === 'NETWORK' || err.status >= 500
              ? `${err.message} Retrying will reuse the same operation id, so it cannot apply twice.`
              : err.message,
          code: err.code,
          fieldErrors: err.fieldErrors,
          refresh: false,
          retryable: err.code === 'NETWORK' || err.status >= 500,
        };
        setOutcome(view);
        toast({ tone: 'error', title: view.title, message: view.message });
        return null;
      } finally {
        inflight.current = false;
        setPending(false);
      }
    },
    [qc, toast],
  );

  const reset = useCallback(() => {
    attempt.current = null;
    setOutcome(null);
  }, []);

  return { submit, pending, outcome, reset };
}
