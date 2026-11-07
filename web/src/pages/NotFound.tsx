import { Home } from 'lucide-react';
import { useT } from '@/i18n';
import { EmptyState, LinkButton } from '@/components/ui';

export default function NotFound() {
  const t = useT();
  return (
    <EmptyState
      title={t('notFound.title')}
      body={t('notFound.body')}
      action={
        <LinkButton to="/" variant="primary" icon={<Home className="h-4 w-4" />}>
          {t('notFound.home')}
        </LinkButton>
      }
    />
  );
}
