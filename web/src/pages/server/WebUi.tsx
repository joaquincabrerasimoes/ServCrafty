import { useParams } from 'react-router-dom';
import { useT } from '@/i18n';
import { webuiFor } from '@/lib/gameDefs';
import { Loading } from '@/components/ui';
import { WebFrame } from '@/components/WebFrame';
import { useServerCtx } from './ServerLayout';

/** A game's own web admin, served by the panel's authenticated reverse proxy inside an iframe. */
export default function WebUi() {
  const t = useT();
  const { uiId = '' } = useParams();
  const { server, def } = useServerCtx();
  const entry = webuiFor(def, server.access).find((w) => w.id === uiId);
  // The server JSON carries the ready-made URL (it redirects into a token-scoped proxy session);
  // otherwise the entry URL is the proxy base plus the entry's path. Never build tokenized URLs here.
  const path = entry?.path ? (entry.path.startsWith('/') ? entry.path : `/${entry.path}`) : '/';
  const src = server.steamGame?.webui?.find((w) => w.id === uiId)?.url || `/api/servers/${encodeURIComponent(server.id)}/webui/${encodeURIComponent(uiId)}${path}`;
  if (!def) return <Loading />;
  const label = entry?.label || uiId;
  return <WebFrame src={src} label={label} running={server.status === 'running'} frameTitle={t('webui.frameTitle', { name: label, server: server.name })} />;
}
