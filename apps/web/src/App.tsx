import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { LogIn } from 'lucide-react';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { ApiError } from './api/client';
import { useMe } from './api/queries';
import { SessionProvider, useSession } from './app/session';
import { NAV, Shell, Wordmark } from './app/Shell';
import { ToastProvider } from './ui/Toast';
import { Button, Callout, Spinner } from './ui/kit';
import { EquipmentPage } from './features/equipment/EquipmentPage';
import { ApprovalsPage } from './features/approvals/ApprovalsPage';
import { HandoversPage } from './features/handovers/HandoversPage';
import { ConflictPage } from './features/conflicts/ConflictPage';
import { FormsPage } from './features/forms/FormsPage';
import { AuditPage } from './features/audit/AuditPage';
import { SettingsPage } from './features/settings/SettingsPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
      staleTime: 15_000,
    },
  },
});

function SignInScreen() {
  const { signIn, error } = useAuth();
  return (
    <div className="signin">
      <div className="signin-card">
        <div className="signin-brand">
          <Wordmark />
        </div>
        <h1 className="page-title">Operations console</h1>
        <p className="muted">
          Manage inventory, repairs, handovers, exceptions and inspection forms. The console is online-only; sign in
          with your TrailOps account.
        </p>
        {error && <Callout tone="error" title="Sign-in problem">{error}</Callout>}
        <Button variant="primary" icon={<LogIn size={20} aria-hidden />} onClick={() => void signIn()} className="btn-block">
          Sign in with TrailOps ID
        </Button>
        <p className="concept-footer">Independent applicant concept · Sample data</p>
      </div>
    </div>
  );
}

function Home() {
  const { canAny } = useSession();
  const first = NAV.find((n) => n.anyOf.length === 0 || canAny(n.anyOf, null));
  return <Navigate to={first?.to ?? '/settings'} replace />;
}

function Guard({ anyOf, children }: { anyOf: string[]; children: JSX.Element }) {
  const { canAny } = useSession();
  if (anyOf.length && !canAny(anyOf, null)) {
    return (
      <div className="page">
        <Callout tone="warning" title="Not available for your role">
          This area needs one of: {anyOf.join(', ')}. Ask an administrator if you need access.
        </Callout>
      </div>
    );
  }
  return children;
}

function Authed() {
  const { signOut } = useAuth();
  const me = useMe(true);
  if (me.isLoading) return <div className="center-screen"><Spinner label="Loading your access" /></div>;
  if (me.error || !me.data) {
    return (
      <div className="center-screen">
        <Callout tone="error" title="Could not load your access" action={<Button onClick={() => void signOut()}>Sign out</Button>}>
          {me.error instanceof Error ? me.error.message : 'Unknown error'}
        </Callout>
      </div>
    );
  }
  const g = (to: string) => NAV.find((n) => n.to === to)!.anyOf;
  return (
    <SessionProvider me={me.data}>
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/equipment" element={<Guard anyOf={g('/equipment')}><EquipmentPage /></Guard>} />
            <Route path="/handovers" element={<Guard anyOf={g('/handovers')}><HandoversPage /></Guard>} />
            <Route path="/approvals" element={<Guard anyOf={g('/approvals')}><ApprovalsPage /></Guard>} />
            <Route path="/conflicts/:id" element={<ConflictPage />} />
            <Route path="/forms" element={<Guard anyOf={g('/forms')}><FormsPage /></Guard>} />
            <Route path="/audit" element={<Guard anyOf={g('/audit')}><AuditPage /></Guard>} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Home />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </SessionProvider>
  );
}

function Gate() {
  const { ready, user } = useAuth();
  if (!ready) return <div className="center-screen"><Spinner label="Starting" /></div>;
  if (!user) return <SignInScreen />;
  return <Authed />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
