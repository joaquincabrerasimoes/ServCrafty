import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './stores/auth';
import { MainLayout } from './layouts/MainLayout';
import { ConfirmHost, Toaster } from './components/feedback';
import { Loading } from './components/ui';
import { PwaPrompt } from './components/PwaPrompt';
import { canAuthorGames } from './lib/gameDefs';
import LoginPage from './pages/Login';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const CreateServer = lazy(() => import('./pages/CreateServer'));
const Templates = lazy(() => import('./pages/Templates'));
const Account = lazy(() => import('./pages/Account'));
const NotFound = lazy(() => import('./pages/NotFound'));

const ServerLayout = lazy(() => import('./pages/server/ServerLayout'));
const Overview = lazy(() => import('./pages/server/Overview'));
const Console = lazy(() => import('./pages/server/Console'));
const Players = lazy(() => import('./pages/server/Players'));
const Files = lazy(() => import('./pages/server/Files'));
const Properties = lazy(() => import('./pages/server/Properties'));
const Mods = lazy(() => import('./pages/server/Mods'));
const Backups = lazy(() => import('./pages/server/Backups'));
const Schedules = lazy(() => import('./pages/server/Schedules'));
const Webhooks = lazy(() => import('./pages/server/Webhooks'));
const Sharing = lazy(() => import('./pages/server/Sharing'));
const Transfer = lazy(() => import('./pages/server/Transfer'));
const ServerSettings = lazy(() => import('./pages/server/Settings'));
const Workshop = lazy(() => import('./pages/server/Workshop'));
const WebUi = lazy(() => import('./pages/server/WebUi'));
const BlueMap = lazy(() => import('./pages/server/BlueMap'));

const AdminUsers = lazy(() => import('./pages/admin/Users'));
const AdminSettings = lazy(() => import('./pages/admin/Settings'));
const AdminPorts = lazy(() => import('./pages/admin/Ports'));
const AdminAudit = lazy(() => import('./pages/admin/Audit'));
const AdminSystem = lazy(() => import('./pages/admin/System'));
const AdminUpdate = lazy(() => import('./pages/admin/Update'));
const AdminGames = lazy(() => import('./pages/admin/Games'));
const AdminGameEditor = lazy(() => import('./pages/admin/GameEditor'));

function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  const location = useLocation();
  if (status === 'loading') return <Loading />;
  if (status !== 'authenticated') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const role = useAuth((s) => s.user?.role);
  if (role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Admins and users allowed to author game definitions. */
function RequireGameAuthor({ children }: { children: ReactNode }) {
  const user = useAuth((s) => s.user);
  if (!canAuthorGames(user)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  const refresh = useAuth((s) => s.refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <MainLayout />
              </RequireAuth>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="servers/new" element={<CreateServer />} />
            <Route path="servers/:id" element={<ServerLayout />}>
              <Route index element={<Overview />} />
              <Route path="console" element={<Console />} />
              <Route path="players" element={<Players />} />
              <Route path="files" element={<Files />} />
              <Route path="properties" element={<Properties />} />
              <Route path="mods" element={<Mods />} />
              <Route path="workshop" element={<Workshop />} />
              <Route path="webui/:uiId" element={<WebUi />} />
              <Route path="map" element={<BlueMap />} />
              <Route path="backups" element={<Backups />} />
              <Route path="schedules" element={<Schedules />} />
              <Route path="webhooks" element={<Webhooks />} />
              <Route path="sharing" element={<Sharing />} />
              <Route path="transfer" element={<Transfer />} />
              <Route path="settings" element={<ServerSettings />} />
            </Route>
            <Route path="templates" element={<Templates />} />
            <Route path="account" element={<Account />} />
            <Route
              path="admin/games"
              element={
                <RequireGameAuthor>
                  <AdminGames />
                </RequireGameAuthor>
              }
            />
            <Route
              path="admin/games/:id"
              element={
                <RequireGameAuthor>
                  <AdminGameEditor />
                </RequireGameAuthor>
              }
            />
            <Route
              path="admin/*"
              element={
                <RequireAdmin>
                  <Routes>
                    <Route index element={<Navigate to="users" replace />} />
                    <Route path="users" element={<AdminUsers />} />
                    <Route path="settings" element={<AdminSettings />} />
                    <Route path="ports" element={<AdminPorts />} />
                    <Route path="audit" element={<AdminAudit />} />
                    <Route path="system" element={<AdminSystem />} />
                    <Route path="update" element={<AdminUpdate />} />
                  </Routes>
                </RequireAdmin>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
      <Toaster />
      <ConfirmHost />
      <PwaPrompt />
    </>
  );
}
