const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local calendar date (device timezone; camps in this POC share Asia/Kolkata). */
export function todayIso(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function formatTime(iso: string | number | null | undefined): string {
  if (iso == null) return '—';
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Freshness label for downloaded data (spec §10: stale snapshots are labelled). */
export function freshness(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'not downloaded yet';
  const mins = Math.round((now - ts) / 60000);
  if (mins < 2) return 'just updated';
  if (mins < 60) return `${mins} min old`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h old`;
  return `${Math.round(h / 24)} days old`;
}
