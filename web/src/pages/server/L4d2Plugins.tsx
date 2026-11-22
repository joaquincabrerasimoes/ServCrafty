import { Users } from 'lucide-react';
import { l4d2Api, l4d2Keys } from '@/api';
import type { L4dPluginCategory } from '@/api/types';
import { useT, type TKey } from '@/i18n';
import { Note } from '../create/TerrariaConfigStep';
import { useServerCtx } from './ServerLayout';
import { CategoryHelp, PluginStore } from './PluginStore';

const CATEGORIES: L4dPluginCategory[] = ['base', 'slots', 'library'];

export default function L4d2Plugins() {
  const t = useT();
  const { server } = useServerCtx();
  return (
    <PluginStore
      queryKey={l4d2Keys.plugins(server.id)}
      load={() => l4d2Api.plugins(server.id)}
      install={(pluginId) => l4d2Api.installPlugin(server.id, pluginId)}
      remove={(pluginId) => l4d2Api.removePlugin(server.id, pluginId)}
      saveSettings={(pluginId, settings) => l4d2Api.pluginSettings(server.id, pluginId, settings)}
      intro={<Note>{t('l4d2.plugins.intro')}</Note>}
      notInstalled={t('l4d2.plugins.notInstalled')}
      categories={CATEGORIES.map((cat) => ({
        id: cat,
        title: t(`l4d2.plugins.cat.${cat}` as TKey),
        description: t(`l4d2.plugins.catBody.${cat}` as TKey),
        help:
          cat === 'slots' ? (
            <CategoryHelp icon={<Users className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />}>{t('l4d2.plugins.slotsHelp')}</CategoryHelp>
          ) : undefined,
      }))}
    />
  );
}
