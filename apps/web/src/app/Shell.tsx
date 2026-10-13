import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  ArrowLeftRight,
  ChevronDown,
  CircleCheck,
  FileText,
  History,
  LogOut,
  MapPin,
  Menu,
  Package,
  RefreshCw,
  Settings,
  X,
} from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { useDevices } from '../api/queries';
import { ROLE_LABEL, useSession } from './session';
import { fmtDateTime, fmtRelative, initials } from '../ui/kit';

export interface NavItem {
  to: string;
  label: string;
  icon: typeof Package;
  /** Visible if the user holds any of these (UI convenience; the server enforces). */
  anyOf: string[];
}

export const NAV: NavItem[] = [
  { to: '/equipment', label: 'Equipment', icon: Package, anyOf: ['equipment.read'] },
  { to: '/handovers', label: 'Handovers', icon: ArrowLeftRight, anyOf: ['transfer.dispatch', 'transfer.receive', 'transfer.resolve'] },
  { to: '/approvals', label: 'Approvals', icon: CircleCheck, anyOf: ['repair.approve', 'repair.work', 'repair.release'] },
  { to: '/forms', label: 'Forms', icon: FileText, anyOf: ['forms.edit', 'forms.publish'] },
  { to: '/audit', label: 'Audit trail', icon: History, anyOf: ['audit.read'] },
  { to: '/settings', label: 'Settings', icon: Settings, anyOf: [] },
];

export function Wordmark() {
  return (
    <div className="wordmark">
      <span className="wordmark-text">TrailOps</span>
      <span className="wordmark-concept">Indiahikes concept</span>
    </div>
  );
}

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

/** Devices that REPORTED pending work when they last synced. Unreported device state is unknown (spec §21). */
function DeviceIndicator() {
  const { can } = useSession();
  const enabled = can('dashboard.read', null);
  const { data } = useDevices(enabled);
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  if (!enabled || !data) return null;
  const reporting = data.filter((d) => (d.reported_pending ?? 0) > 0);
  return (
    <div className="topbar-item popover-host" ref={ref}>
      <button className="topbar-btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <RefreshCw size={20} aria-hidden />
        <span className="hide-sm">
          {reporting.length === 0
            ? 'No devices reported pending sync'
            : `${reporting.length} device${reporting.length === 1 ? '' : 's'} reported pending sync`}
        </span>
        <span className="show-sm">{reporting.length}</span>
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Device sync reports">
          <h3>Device sync reports</h3>
          <p className="muted small">
            Counts are only what each device reported the last time it reached the server. Devices that have not
            connected since may hold more unsent work — the console cannot know.
          </p>
          {data.length === 0 && <p className="muted">No devices have registered yet.</p>}
          <ul className="device-list">
            {data.map((d) => (
              <li key={d.id}>
                <div>
                  <strong>{d.label || `${d.platform} device`}</strong>
                  <span className="muted small"> · {d.user}</span>
                </div>
                <div className="small">
                  {d.reported_pending_at ? (
                    <>
                      Reported <strong>{d.reported_pending ?? 0}</strong> pending at {fmtDateTime(d.reported_pending_at)}
                    </>
                  ) : (
                    <span className="muted">Has not reported a pending count</span>
                  )}
                </div>
                <div className="muted small">Last seen {fmtRelative(d.last_seen_at)}{!d.enabled && ' · disabled'}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CampSelector() {
  const { me, camp, setCampId } = useSession();
  if (!camp) return <span className="topbar-item muted">No camp access</span>;
  return (
    <label className="topbar-item camp-select">
      <MapPin size={20} aria-hidden />
      <span className="sr-only">Camp</span>
      <select value={camp.id} onChange={(e) => setCampId(e.target.value)} aria-label="Select camp">
        {me.camps.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name.replace(/ base camp$/i, '')}
          </option>
        ))}
      </select>
      <ChevronDown size={16} aria-hidden className="select-chevron" />
    </label>
  );
}

function UserMenu() {
  const { me } = useSession();
  const { signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  return (
    <div className="topbar-item popover-host" ref={ref}>
      <button className="user-btn" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        <span className="avatar avatar-dark">{initials(me.user.display_name)}</span>
        <span className="user-meta hide-sm">
          <strong>{me.user.display_name}</strong>
          <span>{ROLE_LABEL[me.role] ?? me.role}</span>
        </span>
        <ChevronDown size={18} aria-hidden />
      </button>
      {open && (
        <div className="popover popover-right" role="menu">
          <p className="small">
            Signed in as <strong>{me.user.email ?? me.user.display_name}</strong>
          </p>
          <NavLink to="/settings" role="menuitem" className="menu-link" onClick={() => setOpen(false)}>
            <Settings size={18} aria-hidden /> Settings & access
          </NavLink>
          <button role="menuitem" className="menu-link" onClick={() => void signOut()}>
            <LogOut size={18} aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { canAny } = useSession();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setNavOpen(false), [location.pathname]);
  const items = NAV.filter((n) => n.anyOf.length === 0 || canAny(n.anyOf, null));
  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <button
          className="icon-btn nav-toggle"
          aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={navOpen}
          aria-controls="sidebar"
          onClick={() => setNavOpen((o) => !o)}
        >
          {navOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
        <Wordmark />
        <div className="topbar-right">
          <DeviceIndicator />
          <CampSelector />
          <UserMenu />
        </div>
      </header>
      <nav id="sidebar" className="sidebar" aria-label="Main">
        <ul>
          {items.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                <n.icon size={22} aria-hidden />
                <span>{n.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden />}
      <main id="main" className="main" tabIndex={-1}>
        {children}
        <footer className="concept-footer">Independent applicant concept · Sample data · Online console</footer>
      </main>
    </div>
  );
}
