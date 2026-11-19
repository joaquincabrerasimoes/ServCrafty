import { useId, useMemo, useState } from 'react';
import type { L4dGameMode } from '@/api/types';
import { useT } from '@/i18n';
import { chaptersOf, findMap, isMode, useL4dMaps } from '@/lib/l4d2';
import { Spinner } from './ui';

const MAP_RE = /^[A-Za-z0-9_.-]*$/;

/**
 * Map chooser for Left 4 Dead 2: campaign, then chapter (for `mode`), plus a free "map name" field that
 * suggests every map on the server. Without a server id (create wizard), or while the maps cannot be
 * loaded, only the map name field is shown.
 */
export function L4d2MapPicker({
  serverId,
  value,
  onChange,
  mode,
  disabled,
  invalid,
}: {
  serverId?: string;
  value: string;
  onChange: (map: string) => void;
  /** Game mode whose chapters are offered (default coop). */
  mode?: L4dGameMode | string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const t = useT();
  const id = useId();
  const q = useL4dMaps(serverId);
  const m: L4dGameMode = isMode(mode) ? mode : 'coop';
  // Campaign the user picked; null = follow the campaign the current value belongs to.
  const [picked, setPicked] = useState<string | null>(null);
  const data = q.data;
  const campaigns = useMemo(() => data?.campaigns ?? [], [data]);
  const resolved = useMemo(() => findMap(campaigns, value, m), [campaigns, value, m]);
  const campaignId = picked ?? resolved?.campaign.id ?? '';
  const campaign = campaigns.find((c) => c.id === campaignId);
  const chapters = chaptersOf(campaign, m);
  const official = campaigns.filter((c) => c.source === 'official');
  const addons = campaigns.filter((c) => c.source !== 'official');
  const invalidName = !MAP_RE.test(value);

  const nameInput = (
    <span className="relative block">
      <input
        id={`${id}-map`}
        className="input font-mono"
        value={value}
        list={data?.maps.length ? `${id}-list` : undefined}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="none"
        autoComplete="off"
        maxLength={64}
        placeholder="c2m1_highway"
        aria-invalid={invalid || invalidName}
        aria-label={data ? undefined : t('l4d2.picker.mapName')}
        onChange={(e) => {
          setPicked(null);
          onChange(e.target.value.trim());
        }}
      />
      {serverId && q.isLoading && <Spinner className="absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2" />}
    </span>
  );

  if (!serverId || !data) {
    return (
      <div>
        {nameInput}
        {serverId && q.error ? <p className="hint">{t('l4d2.picker.loadFailed')}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block min-w-0">
          <span className="mb-1 block text-xs font-medium text-muted">{t('l4d2.picker.campaign')}</span>
          <select
            className="input"
            value={campaignId}
            disabled={disabled}
            onChange={(e) => {
              const next = e.target.value;
              setPicked(next);
              const c = campaigns.find((x) => x.id === next);
              const first = chaptersOf(c, m)[0];
              if (first) onChange(first.map);
            }}
          >
            <option value="">{t('l4d2.picker.otherMap')}</option>
            {official.length > 0 && (
              <optgroup label={t('l4d2.picker.official')}>
                {official.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </optgroup>
            )}
            {addons.length > 0 && (
              <optgroup label={t('l4d2.picker.addons')}>
                {addons.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        {campaign && chapters.length > 0 ? (
          <label className="block min-w-0">
            <span className="mb-1 block text-xs font-medium text-muted">{t('l4d2.picker.chapter')}</span>
            <select className="input" value={chapters.some((c) => c.map === value) ? value : ''} disabled={disabled} onChange={(e) => e.target.value && onChange(e.target.value)}>
              {!chapters.some((c) => c.map === value) && <option value="">{t('l4d2.picker.chooseChapter')}</option>}
              {chapters.map((c, i) => (
                <option key={c.map} value={c.map}>
                  {i + 1}. {c.title || c.map}
                </option>
              ))}
            </select>
          </label>
        ) : campaign ? (
          <p className="self-end text-xs text-muted sm:pb-2.5">{t('l4d2.picker.noChapters')}</p>
        ) : null}
      </div>
      <div>
        <label htmlFor={`${id}-map`} className="mb-1 block text-xs font-medium text-muted">
          {t('l4d2.picker.mapName')}
        </label>
        {nameInput}
      </div>
      {data.maps.length > 0 && (
        <datalist id={`${id}-list`}>
          {data.maps.map((x) => (
            <option key={x.map} value={x.map}>
              {x.source ?? ''}
            </option>
          ))}
        </datalist>
      )}
    </div>
  );
}
