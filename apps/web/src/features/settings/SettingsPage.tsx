import { useState } from 'react';
import { LogOut, Users } from 'lucide-react';
import { useCamps, useUsers } from '../../api/queries';
import type { CampWithLocations, UserRow } from '../../api/types';
import { useCommand } from '../../api/useCommand';
import { useAuth } from '../../auth/AuthProvider';
import { ROLE_LABEL, useSession } from '../../app/session';
import { Avatar, Badge, Button, Callout, Dialog, ErrorState, ReceiptNotice, Spinner } from '../../ui/kit';

/** Extra per-camp grants an administrator may add on top of the coarse role (spec §4). */
const GRANTABLE = [
  'transfer.dispatch',
  'transfer.receive',
  'transfer.resolve',
  'repair.approve',
  'repair.work',
  'repair.release',
  'equipment.manage',
  'equipment.retire',
  'conflict.resolve',
];

function CampAccessRow({ user, camp }: { user: UserRow; camp: CampWithLocations }) {
  const current = user.camps.find((c) => c.camp_id === camp.id);
  const [enabled, setEnabled] = useState(current?.enabled ?? false);
  const [perms, setPerms] = useState<string[]>(current?.permissions ?? []);
  const cmd = useCommand({ success: `${user.display_name}: ${camp.name} access updated` });
  const changed = enabled !== (current?.enabled ?? false) || [...perms].sort().join() !== [...(current?.permissions ?? [])].sort().join();
  return (
    <fieldset className="camp-access">
      <legend>{camp.name}</legend>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Member of this camp
      </label>
      <div className="perm-grid" aria-label={`Extra grants at ${camp.name}`}>
        {GRANTABLE.map((p) => (
          <label key={p} className="check small">
            <input
              type="checkbox"
              disabled={!enabled}
              checked={perms.includes(p)}
              onChange={(e) => setPerms((xs) => (e.target.checked ? [...xs, p] : xs.filter((x) => x !== p)))}
            />
            <code>{p}</code>
          </label>
        ))}
      </div>
      <Button
        variant="primary"
        className="btn-sm"
        pending={cmd.pending}
        disabled={!changed}
        onClick={() =>
          void cmd.submit({
            type: 'MEMBERSHIP_UPDATE',
            aggregate_id: null,
            payload: { user_id: user.id, camp_id: camp.id, enabled, permissions: enabled ? [...perms].sort() : [] },
          })
        }
      >
        Save {camp.name.replace(/ base camp$/i, '')} access
      </Button>
      <ReceiptNotice outcome={cmd.outcome} />
    </fieldset>
  );
}

function AccessManager() {
  const users = useUsers(true);
  const camps = useCamps();
  const [editingId, setEditingId] = useState<string | null>(null);
  // Always render from the latest server data so a saved change becomes the new baseline.
  const editing = users.data?.find((u) => u.id === editingId) ?? null;
  const campName = (id: string) => camps.data?.find((c) => c.id === id)?.name.replace(/ base camp$/i, '') ?? id.slice(0, 8);
  return (
    <section className="panel" aria-labelledby="access-h">
      <h2 id="access-h" className="section-title">
        <Users size={20} aria-hidden /> User & camp access
      </h2>
      <p className="muted small">
        Changes take effect on the user's next request and force their devices to refresh scope. Roles come from the organisation
        membership; camp membership and extra grants are managed here.
      </p>
      {users.isLoading && <Spinner label="Loading users" />}
      {users.error && <ErrorState error={users.error} onRetry={() => void users.refetch()} />}
      {users.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Role</th>
                <th scope="col">Camps</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((u) => (
                <tr key={u.id}>
                  <td>
                    <span className="loc-cell">
                      <Avatar name={u.display_name} />
                      <span>
                        <strong>{u.display_name}</strong>
                        <span className="muted small block">{u.email}</span>
                      </span>
                    </span>
                  </td>
                  <td>
                    {ROLE_LABEL[u.role] ?? u.role} {!u.enabled && <Badge tone="error">Disabled</Badge>}
                  </td>
                  <td>
                    {u.camps.length === 0 && <span className="muted">—</span>}
                    {u.camps.map((c) => (
                      <span key={c.camp_id} className="chip">
                        {campName(c.camp_id)}
                        {!c.enabled && ' (revoked)'}
                        {c.permissions.length > 0 && ` +${c.permissions.length}`}
                      </span>
                    ))}
                  </td>
                  <td>
                    <Button className="btn-sm" onClick={() => setEditingId(u.id)}>
                      Manage access
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && camps.data && (
        <Dialog title={`Access · ${editing.display_name}`} description={`${ROLE_LABEL[editing.role] ?? editing.role}. Each camp saves as its own audited command.`} onClose={() => setEditingId(null)} wide>
          {camps.data.map((c) => (
            <CampAccessRow key={`${c.id}:${JSON.stringify(editing.camps.find((x) => x.camp_id === c.id) ?? null)}`} user={editing} camp={c} />
          ))}
        </Dialog>
      )}
    </section>
  );
}

export function SettingsPage() {
  const { me, can } = useSession();
  const { signOut } = useAuth();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">Your identity and access as the server currently resolves it.</p>
        </div>
        <Button icon={<LogOut size={18} aria-hidden />} onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
      <div className="settings-grid">
        <section className="panel" aria-labelledby="me-h">
          <h2 id="me-h" className="section-title">Your account</h2>
          <div className="loc-cell">
            <Avatar name={me.user.display_name} dark />
            <span>
              <strong>{me.user.display_name}</strong>
              <span className="muted small block">{me.user.email}</span>
            </span>
          </div>
          <dl className="facts">
            <dt>Role</dt>
            <dd>{ROLE_LABEL[me.role] ?? me.role}</dd>
            <dt>Scope</dt>
            <dd>{me.org_wide ? 'Organisation-wide' : `${me.camps.length} camp${me.camps.length === 1 ? '' : 's'}`}</dd>
            <dt>Scope epoch</dt>
            <dd>{me.scope_epoch}</dd>
            <dt>Offline allowance</dt>
            <dd>{me.offline_allowance_hours} h (mobile only — this console is online-only)</dd>
          </dl>
          <h3>Camps</h3>
          <ul className="plain-list">
            {me.camps.map((c) => (
              <li key={c.id}>
                <strong>{c.name}</strong> <span className="muted small">{c.code} · {c.timezone}</span>
                {c.extra_permissions.length > 0 && (
                  <div className="chips">
                    {c.extra_permissions.map((p) => (
                      <span key={p} className="chip"><code>{p}</code></span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section className="panel" aria-labelledby="perm-h">
          <h2 id="perm-h" className="section-title">Permissions</h2>
          <p className="muted small">Hidden buttons are a convenience only. The server re-checks every permission and camp on each command.</p>
          <div className="chips">
            {me.permissions.map((p) => (
              <span key={p} className="chip">
                <code>{p}</code>
              </span>
            ))}
          </div>
        </section>
      </div>
      {can('access.manage', null) ? (
        <AccessManager />
      ) : (
        <Callout tone="info">Membership changes are made by administrators.</Callout>
      )}
    </div>
  );
}
