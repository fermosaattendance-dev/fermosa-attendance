import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AuthProvider, useAuth } from './lib/auth';
import { Branches } from './pages/Branches';
import { EmployeeForm } from './pages/EmployeeForm';
import { Employees } from './pages/Employees';
import { Login } from './pages/Login';
import { Org } from './pages/Org';
import { Overview } from './pages/Overview';
import { Punches } from './pages/Punches';
import { Kiosks } from './pages/Kiosks';
import { Reviews } from './pages/Reviews';
import { Settings } from './pages/Settings';

function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-gray-400">
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

function RequireAuth() {
  const { session, profile, loading, signOut } = useAuth();
  if (loading) return <Loading />;
  if (!session) return <Navigate to="/login" replace />;
  if (!profile) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center text-sm text-gray-500">
        <p>Your account has no employee profile yet. Ask HR to complete your registration.</p>
        <button
          onClick={signOut}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-100"
        >
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
            <Route path="/" element={<Overview />} />
            <Route path="/employees" element={<Employees />} />
            <Route path="/employees/new" element={<EmployeeForm />} />
            <Route path="/employees/:id" element={<EmployeeForm />} />
            <Route path="/punches" element={<Punches />} />
            <Route path="/reviews" element={<Reviews />} />
            <Route path="/kiosks" element={<Kiosks />} />
            <Route path="/branches" element={<Branches />} />
            <Route path="/org" element={<Org />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
