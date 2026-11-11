import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import {
  Activity,
  ArrowUpCircle,
  Boxes,
  Cog,
  Gamepad2,
  LayoutGrid,
  LogOut,
  Menu,
  Network,
  Plus,
  ScrollText,
  Server as ServerIcon,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { useT } from '@/i18n';
import { useServers } from '@/lib/queries';
import { StatusDot } from '@/components/StatusBadge';
import { LocaleSelect, ThemeSwitch } from '@/components/PrefsControls';
import { liveSocket } from '@/ws/live';
import { queryClient } from '@/lib/queryClient';
import { UpdateBanner } from '@/components/UpdateBanner';
import { fmtVersion, useAppVersion, useUpdateInfo } from '@/lib/updates';
import { canAuthorGames } from '@/lib/gameDefs';

function NavItem({ to, icon: Icon, children, end }: { to: string; icon: typeof Cog; children: React.ReactNode; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-3 rounded-block px-3 py-2 text-sm',
          isActive ? 'bg-raised font-medium text-ink shadow-[inset_3px_0_0_rgb(var(--accent))]' : 'text-muted hover:bg-raised/60 hover:text-ink',
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{children}</span>
    </NavLink>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();
  const { data: servers } = useServers();
  const isAdmin = user?.role === 'admin';
  const version = useAppVersion();
  const updateAvailable = !!useUpdateInfo().data?.updateAvailable;

  return (
    <div className="flex h-full flex-col" onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}>
      <Link to="/" className="flex items-center gap-2.5 px-4 pb-4 pt-5">
        <img src="/favicon.svg" alt="" className="h-8 w-8" />
        <span className="font-display text-xl font-bold tracking-tight">ServCrafty</span>
      </Link>

      <nav className="scrollbar-thin flex-1 space-y-6 overflow-y-auto px-3 pb-4">
        <div className="space-y-0.5">
          <NavItem to="/" icon={LayoutGrid} end>
            {t('nav.servers')}
          </NavItem>
          <NavItem to="/templates" icon={Boxes}>
            {t('nav.templates')}
          </NavItem>
          <NavItem to="/account" icon={UserRound}>
            {t('nav.account')}
          </NavItem>
          {!isAdmin && canAuthorGames(user) && (
            <NavItem to="/admin/games" icon={Gamepad2}>
              {t('nav.games')}
            </NavItem>
          )}
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between px-3">
            <span className="text-xs font-medium text-muted">{t('nav.yourServers')}</span>
            <Link to="/servers/new" className="text-muted hover:text-accent" title={t('dashboard.create')}>
              <Plus className="h-4 w-4" />
            </Link>
          </div>
          <div className="space-y-0.5">
            {servers?.map((s) => (
              <NavLink
                key={s.id}
                to={`/servers/${s.id}`}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-2.5 rounded-block px-3 py-1.5 text-sm',
                    isActive ? 'bg-raised text-ink' : 'text-muted hover:bg-raised/60 hover:text-ink',
                  )
                }
              >
                <StatusDot status={s.status} />
                <span className="truncate">{s.name}</span>
              </NavLink>
            ))}
            {servers && servers.length === 0 && <p className="px-3 py-1 text-xs text-muted">{t('nav.noServers')}</p>}
          </div>
        </div>

        {isAdmin && (
          <div>
            <div className="mb-1 px-3 text-xs font-medium text-muted">{t('nav.admin')}</div>
            <div className="space-y-0.5">
              <NavItem to="/admin/users" icon={Users}>
                {t('nav.users')}
              </NavItem>
              <NavItem to="/admin/settings" icon={Cog}>
                {t('nav.settings')}
              </NavItem>
              <NavItem to="/admin/games" icon={Gamepad2}>
                {t('nav.games')}
              </NavItem>
              <NavItem to="/admin/ports" icon={Network}>
                {t('nav.ports')}
              </NavItem>
              <NavItem to="/admin/audit" icon={ScrollText}>
                {t('nav.audit')}
              </NavItem>
              <NavItem to="/admin/system" icon={Activity}>
                {t('nav.system')}
              </NavItem>
              <NavItem to="/admin/update" icon={ArrowUpCircle}>
                <span className="flex items-center gap-2">
                  {t('nav.updates')}
                  {updateAvailable && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-label={t('update.availableShort')} />}
                </span>
              </NavItem>
            </div>
          </div>
        )}
      </nav>

      <div className="space-y-3 border-t border-line p-3">
        <div className="flex gap-2">
          <ThemeSwitch className="flex-1" iconsOnly />
          <LocaleSelect className="w-28" />
        </div>
        <div className="flex items-center gap-2 px-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-block bg-accent/15 font-display text-sm font-bold text-accent">
            {user?.username.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{user?.username}</div>
            <div className="text-xs text-muted">{user?.role === 'admin' ? t('role.admin') : t('role.user')}</div>
          </div>
          <button
            className="rounded-block p-2 text-muted hover:bg-raised hover:text-danger"
            title={t('nav.logout')}
            aria-label={t('nav.logout')}
            onClick={async () => {
              await logout();
              liveSocket.reset();
              queryClient.clear();
              navigate('/login');
            }}
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
        {version && (
          <div className="flex items-center justify-between px-1 text-[11px] text-muted">
            <span className="font-mono">ServCrafty {fmtVersion(version)}</span>
            {isAdmin && updateAvailable && (
              <Link to="/admin/update" className="font-medium text-accent hover:underline">
                {t('update.availableShort')}
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function MainLayout() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 border-r border-line bg-surface lg:block">
        <Sidebar />
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/45" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-line bg-surface shadow-xl">
            <button className="absolute right-2 top-4 rounded-block p-2 text-muted" onClick={() => setOpen(false)} aria-label={t('common.close')}>
              <X className="h-5 w-5" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface/95 px-4 backdrop-blur lg:hidden">
          <button className="-ml-2 rounded-block p-2" onClick={() => setOpen(true)} aria-label={t('nav.menu')}>
            <Menu className="h-5 w-5" />
          </button>
          <Link to="/" className="flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="h-6 w-6" />
            <span className="font-display text-lg font-bold">ServCrafty</span>
          </Link>
          <Link to="/servers/new" className="ml-auto rounded-block p-2 text-muted" aria-label={t('dashboard.create')}>
            <ServerIcon className="h-5 w-5" />
          </Link>
        </header>
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <UpdateBanner />
          <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
