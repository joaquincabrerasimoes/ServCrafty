import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Trash2 } from 'lucide-react';
import { serversApi } from '@/api';
import { ServerIcon } from '@/components/ServerIcon';
import { Button, Section } from '@/components/ui';
import { useT } from '@/i18n';
import { canManage } from '@/lib/access';
import { qk } from '@/lib/queries';
import { toast } from '@/stores/toast';
import { useServerCtx } from './ServerLayout';

const SIZE = 64;

/** Centre-crops any image to a square and scales it to the 64x64 PNG Minecraft expects. */
async function toIcon(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  bmp.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'));
}

/** View and change the multiplayer-list icon (`server-icon.png`) of a Java server. */
export function ServerIconCard() {
  const t = useT();
  const qc = useQueryClient();
  const { server } = useServerCtx();
  const manage = canManage(server.access);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => () => { if (pending) URL.revokeObjectURL(pending.url); }, [pending]);

  const done = (restartRequired: boolean, key: 'icon.saved' | 'icon.removed') => {
    toast.success(restartRequired ? t('icon.restart') : t(key));
    setPending(null);
    void qc.invalidateQueries({ queryKey: qk.server(server.id) });
    void qc.invalidateQueries({ queryKey: qk.servers });
  };
  const save = useMutation({
    mutationFn: (blob: Blob) => {
      const fd = new FormData();
      fd.append('file', blob, 'server-icon.png');
      return serversApi.setIcon(server.id, fd);
    },
    onSuccess: (r) => done(r.restartRequired, 'icon.saved'),
    onError: (err) => toast.error(err),
  });
  const remove = useMutation({
    mutationFn: () => serversApi.removeIcon(server.id),
    onSuccess: (r) => done(r.restartRequired, 'icon.removed'),
    onError: (err) => toast.error(err),
  });

  if (!manage && server.icon == null) return null;
  return (
    <Section title={t('icon.title')} description={t('icon.description')}>
      <div className="flex flex-wrap items-center gap-5">
        <div className="flex h-24 w-24 items-center justify-center rounded-md border border-line bg-raised">
          {pending ? (
            <img src={pending.url} alt="" width={64} height={64} className="h-16 w-16 [image-rendering:pixelated]" />
          ) : server.icon != null ? (
            <ServerIcon server={server} className="h-16 w-16" />
          ) : (
            <span className="px-2 text-center text-xs text-muted">{t('icon.none')}</span>
          )}
        </div>
        {manage && (
          <div className="space-y-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                toIcon(f)
                  .then((blob) => setPending({ blob, url: URL.createObjectURL(blob) }))
                  .catch(() => toast.error(t('icon.readError')));
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button icon={<ImagePlus className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>
                {t('icon.choose')}
              </Button>
              {pending && (
                <>
                  <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(pending.blob)}>
                    {t('icon.save')}
                  </Button>
                  <Button variant="ghost" onClick={() => setPending(null)}>
                    {t('common.cancel')}
                  </Button>
                </>
              )}
              {!pending && server.icon != null && (
                <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} loading={remove.isPending} onClick={() => remove.mutate()}>
                  {t('icon.remove')}
                </Button>
              )}
            </div>
            <p className="hint">{t('icon.hint')}</p>
          </div>
        )}
      </div>
    </Section>
  );
}
