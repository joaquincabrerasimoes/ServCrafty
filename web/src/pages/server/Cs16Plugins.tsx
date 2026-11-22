import { cs16Api, cs16Keys } from '@/api';
import type { Cs16PluginCategory } from '@/api/types';
import { useT, type TKey } from '@/i18n';
import { Note } from '../create/TerrariaConfigStep';
import { useServerCtx } from './ServerLayout';
import { PluginStore } from './PluginStore';

const CATEGORIES: Cs16PluginCategory[] = ['base', 'bots', 'library'];

export default function Cs16Plugins() {
  const t = useT();
  const { server } = useServerCtx();
  return (
    <PluginStore
      queryKey={cs16Keys.plugins(server.id)}
      load={() => cs16Api.plugins(server.id)}
      install={(pluginId) => cs16Api.installPlugin(server.id, pluginId)}
      remove={(pluginId) => cs16Api.removePlugin(server.id, pluginId)}
      intro={
        <div className="space-y-2">
          <Note>{t('cs16.plugins.intro')}</Note>
          <ul className="list-disc space-y-1 ps-5 text-xs text-muted">
            <li>{t('cs16.plugins.noteMetamod')}</li>
            <li>{t('cs16.plugins.noteAdmins')}</li>
            <li>{t('cs16.plugins.noteYapb')}</li>
          </ul>
        </div>
      }
      notInstalled={t('l4d2.plugins.notInstalled')}
      categories={CATEGORIES.map((cat) => ({
        id: cat,
        title: t(`cs16.plugins.cat.${cat}` as TKey),
        description: t(`cs16.plugins.catBody.${cat}` as TKey),
      }))}
    />
  );
}
