const fmt = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Key-by-key before/after view of an audit event. */
export function AuditDiff({
  before,
  after,
  compact,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  compact?: boolean;
}) {
  const keys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]));
  if (keys.length === 0) return compact ? null : <span className="muted">—</span>;
  return (
    <table className={`diff ${compact ? 'diff-compact' : ''}`}>
      <tbody>
        {keys.map((k) => {
          const b = before?.[k];
          const a = after?.[k];
          const changed = fmt(b) !== fmt(a);
          return (
            <tr key={k} className={changed ? 'diff-changed' : ''}>
              <th scope="row">{k}</th>
              <td className="diff-before">{before ? fmt(b) : ''}</td>
              <td aria-hidden className="diff-arrow">{before ? '→' : ''}</td>
              <td className="diff-after">{fmt(a)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
