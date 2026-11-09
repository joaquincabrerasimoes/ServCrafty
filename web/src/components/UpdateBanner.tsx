import { Link, useLocation } from 'react-router-dom';
import { ArrowUpCircle, X } from 'lucide-react';
import { useT } from '@/i18n';
import { useIsAdmin } from '@/stores/auth';
import { fmtVersion, useBannerDismissal, useUpdateInfo } from '@/lib/updates';

/** Admin-only notice that a newer ServCrafty release exists. Dismissal is remembered per version. */
export function UpdateBanner() {
  const t = useT();
  const isAdmin = useIsAdmin();
  const location = useLocation();
  const { data } = useUpdateInfo();
  const { dismissed, dismiss } = useBannerDismissal();

  if (!isAdmin || !data?.updateAvailable || !data.latest) return null;
  if (location.pathname.startsWith('/admin/update')) return null;
  const latest = data.latest.version;
  if (dismissed === latest) return null;

  return (
    <div role="status" className="border-b border-accent/30 bg-accent/10">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 py-2.5 text-sm sm:px-6 lg:px-8">
        <ArrowUpCircle className="h-4 w-4 shrink-0 text-accent" />
        <p className="min-w-0 flex-1">
          {t('update.banner', { latest: fmtVersion(latest), current: fmtVersion(data.currentVersion) })}{' '}
          <Link to="/admin/update" className="whitespace-nowrap font-medium text-accent underline-offset-2 hover:underline">
            {t('update.bannerAction')}
          </Link>
        </p>
        <button
          type="button"
          onClick={() => dismiss(latest)}
          className="-mr-1 shrink-0 rounded-block p-1.5 text-muted hover:bg-accent/15 hover:text-ink"
          aria-label={t('update.bannerDismiss')}
          title={t('update.bannerDismiss')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
