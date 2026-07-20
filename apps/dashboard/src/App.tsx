import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { MfaChallenge } from './components/MfaChallenge';
import { AuthProvider, needsMfaChallenge, useAuth } from './lib/auth';
import { Branches } from './pages/Branches';
import { EmployeeForm } from './pages/EmployeeForm';
import { Employees } from './pages/Employees';
import { Login } from './pages/Login';
import { Audit } from './pages/Audit';
import { Org } from './pages/Org';
import { Overview } from './pages/Overview';
import { Punches } from './pages/Punches';
import { Kiosks } from './pages/Kiosks';
import { Leave } from './pages/Leave';
import { Payslips } from './pages/Payslips';
import { Reports } from './pages/Reports';
import { Reviews } from './pages/Reviews';
import { Settings } from './pages/Settings';
import { TimeClock } from './pages/TimeClock';
import { MyLeave } from './pages/MyLeave';
import { MyPayslip } from './pages/MyPayslip';
import { ChangePassword } from './pages/ChangePassword';

function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted">
      Loading…
    </div>
  );
}

function LoginGate() {
  const { session, loading } = useAuth();
  if (loading) return <Loading />;
  if (session) return <Navigate to="/" replace />;
  return <Login />;
}

/** Plain employees land on their own time clock; managers/admins on the ops board. */
function Landing() {
  const { profile } = useAuth();
  if (profile && profile.role === 'employee') return <Navigate to="/my" replace />;
  return <Overview />;
}

function RequireAuth() {
  const { session, profile, aal, aalLoading, loading, signOut } = useAuth();
  if (loading) return <Loading />;
  // A cached profile without a session = offline mode after a browser restart:
  // the clock stays usable; the real session restores itself on reconnect.
  if (!session && !profile) return <Navigate to="/login" replace />;
  if (aalLoading) return <Loading />;
  if (needsMfaChallenge(aal)) return <MfaChallenge />;
  if (!profile) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center text-sm text-muted">
        <p>Your account has no employee profile yet. Ask HR to complete your registration.</p>
        <button onClick={signOut} className="btn">
          Sign out
        </button>
      </div>
    );
  }
  return <Layout />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginGate />} />
          <Route element={<RequireAuth />}>
            <Route path="/" element={<Landing />} />
            <Route path="/my" element={<TimeClock />} />
            <Route path="/my/leave" element={<MyLeave />} />
            <Route path="/my/payslip" element={<MyPayslip />} />
            <Route path="/my/password" element={<ChangePassword />} />
            <Route path="/employees" element={<Employees />} />
            <Route path="/employees/new" element={<EmployeeForm />} />
            <Route path="/employees/:id" element={<EmployeeForm />} />
            <Route path="/punches" element={<Punches />} />
            <Route path="/reviews" element={<Reviews />} />
            <Route path="/leave" element={<Leave />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/payslips" element={<Payslips />} />
            <Route path="/kiosks" element={<Kiosks />} />
            <Route path="/branches" element={<Branches />} />
            <Route path="/org" element={<Org />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
