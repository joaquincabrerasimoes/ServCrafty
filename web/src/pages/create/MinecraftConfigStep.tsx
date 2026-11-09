import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { Info, Plus, Trash2, X } from 'lucide-react';
import { useT, type TKey } from '@/i18n';
import { Button, Field, IconButton, Toggle } from '@/components/ui';
import { LanAnnounceField } from './LanAnnounceField';
import {
  BEDROCK_PLAYER,
  FLAT_PRESETS,
  JAVA_PLAYER,
  NUMBER_RULES,
  PLACEHOLDERS,
  SINGLE_BIOMES,
  fieldsFor,
  type Edition,
  type McErrors,
  type McForm,
} from './minecraftForm';

/* ------------------------------------------------------------ building blocks */

function Group({ title, children, collapsible, defaultOpen = true }: { title: string; children: ReactNode; collapsible?: boolean; defaultOpen?: boolean }) {
  const id = useId();
  const body = <div className="space-y-4 p-4 sm:p-5">{children}</div>;
  if (!collapsible) {
    return (
      <section className="panel min-w-0" aria-labelledby={id}>
        <h3 id={id} className="border-b border-line px-4 py-3 text-base font-semibold sm:px-5">
          {title}
        </h3>
        {body}
      </section>
    );
  }
  return (
    <details className="panel group min-w-0" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md px-4 py-3 text-base font-semibold sm:px-5 [&::-webkit-details-marker]:hidden">
        <span className="font-display">{title}</span>
        <span aria-hidden="true" className="text-muted transition-transform group-open:rotate-90 rtl:-scale-x-100">
          ›
        </span>
      </summary>
      <div className="border-t border-line">{body}</div>
    </details>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 rounded-block border border-line bg-raised px-3 py-2 text-xs text-muted">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function ToggleGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">{children}</div>;
}

/** Tag input: Enter, comma or blur adds; Backspace on an empty field removes the last chip. */
function ChipInput({
  value,
  onChange,
  pattern,
  placeholder,
  label,
  hint,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  pattern: RegExp;
  placeholder?: string;
  label: string;
  hint?: string;
}) {
  const t = useT();
  const id = useId();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const commit = (raw: string) => {
    const names = raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) return true;
    const bad = names.find((n) => !pattern.test(n));
    if (bad) {
      setError(t('mc.err.player', { name: bad }));
      return false;
    }
    const next = [...value];
    for (const n of names) if (!next.some((x) => x.toLowerCase() === n.toLowerCase())) next.push(n);
    if (next.length > 500) {
      setError(t('mc.err.tooMany', { max: 500 }));
      return false;
    }
    onChange(next);
    setDraft('');
    setError(null);
    return true;
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div
        className={clsx(
          'flex min-h-10 flex-wrap items-center gap-1.5 rounded-block border bg-surface px-2 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25',
          error ? 'border-danger' : 'border-line',
        )}
      >
        <ul className="contents" aria-label={label}>
          {value.map((v) => (
            <li key={v} className="inline-flex max-w-full items-center gap-1 rounded-[2px] border border-line bg-raised py-0.5 pe-0.5 ps-2 text-sm">
              <span className="truncate">{v}</span>
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center rounded-[2px] text-muted hover:bg-line hover:text-ink"
                aria-label={t('mc.removeChip', { name: v })}
                onClick={() => onChange(value.filter((x) => x !== v))}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <input
          id={id}
          className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-ink outline-none placeholder:text-muted/70"
          value={draft}
          placeholder={value.length ? '' : placeholder}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKey}
          onBlur={() => commit(draft)}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (/[,\n]/.test(text)) {
              e.preventDefault();
              commit(draft + text);
            }
          }}
          aria-invalid={!!error}
          aria-describedby={`${id}-hint`}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      <span id={`${id}-hint`} className={clsx('mt-1 block text-xs', error ? 'text-danger' : 'text-muted')}>
        {error ?? hint}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------ step */

export function MinecraftConfigStep({
  form,
  set,
  errors,
  edition,
  modpack,
  lanAnnounce,
  onLanAnnounce,
}: {
  form: McForm;
  set: <K extends keyof McForm>(k: K, v: McForm[K]) => void;
  errors: McErrors;
  edition: Edition;
  modpack: boolean;
  lanAnnounce: boolean;
  onLanAnnounce: (v: boolean) => void;
}) {
  const t = useT();
  const has = fieldsFor(edition);
  const bedrock = edition === 'bedrock';
  const ph = PLACEHOLDERS[edition];

  const numberField = (k: keyof McForm, label: TKey, hint?: ReactNode) => {
    const rule = NUMBER_RULES[k]!;
    const min = bedrock && k === 'networkCompressionThreshold' ? 0 : rule.min;
    return (
      <Field label={t(label)} error={errors[k]} hint={hint ?? t('mc.rangeHint', { min, max: rule.max })}>
        <input
          className={clsx('input', errors[k] && 'border-danger')}
          type="number"
          inputMode="numeric"
          min={min}
          max={rule.max}
          step={1}
          value={form[k] as string}
          placeholder={ph[k]}
          aria-invalid={!!errors[k]}
          onChange={(e) => set(k, e.target.value as never)}
        />
      </Field>
    );
  };

  const toggle = (k: keyof McForm, label: TKey) => (
    <Toggle checked={form[k] as boolean} onChange={(v) => set(k, v as never)} label={t(label)} />
  );

  const levelTypes = bedrock
    ? (['default', 'flat', 'legacy'] as const)
    : (['default', 'flat', 'largebiomes', 'amplified', 'single_biome_surface'] as const);

  return (
    <div className="space-y-5">
      <Note>
        {t('mc.intro')} {modpack && t('mc.modpackNote')} {bedrock && t('mc.bedrockNote')}
      </Note>

      <Group title={t('mc.section.general')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('mc.levelName')} error={errors.levelName} hint={t('mc.levelNameHint')}>
            <input
              className="input"
              value={form.levelName}
              maxLength={64}
              placeholder={ph.levelName}
              onChange={(e) => set('levelName', e.target.value)}
              aria-invalid={!!errors.levelName}
            />
          </Field>
          <Field label={bedrock ? t('mc.serverName') : t('mc.motd')} error={errors.motd} hint={bedrock ? t('mc.serverNameHint') : t('mc.motdHint')}>
            <input
              className="input"
              value={form.motd}
              maxLength={256}
              placeholder={ph.motd ?? t('mc.motdPlaceholder')}
              onChange={(e) => set('motd', e.target.value)}
              aria-invalid={!!errors.motd}
            />
          </Field>
          <Field label={t('mc.gameMode')}>
            <select className="input" value={form.gameMode} onChange={(e) => set('gameMode', e.target.value as McForm['gameMode'])}>
              {(['survival', 'creative', 'adventure', ...(bedrock ? [] : (['spectator'] as const))] as const).map((m) => (
                <option key={m} value={m}>
                  {t(`mc.gameMode.${m}` as TKey)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('mc.difficulty')} hint={t('mc.difficultyHint')}>
            <select className="input" value={form.difficulty} onChange={(e) => set('difficulty', e.target.value as McForm['difficulty'])}>
              {(['peaceful', 'easy', 'normal', 'hard'] as const).map((m) => (
                <option key={m} value={m}>
                  {t(`mc.difficulty.${m}` as TKey)}
                </option>
              ))}
            </select>
          </Field>
          {numberField('maxPlayers', 'mc.maxPlayers')}
          {numberField('playerIdleTimeout', 'mc.playerIdleTimeout', t('mc.playerIdleTimeoutHint'))}
        </div>
        <ToggleGrid>
          {toggle('forceGamemode', 'mc.forceGamemode')}
          {has.hardcore && toggle('hardcore', 'mc.hardcore')}
          {has.pvp && toggle('pvp', 'mc.pvp')}
          {toggle('onlineMode', 'mc.onlineMode')}
          {has.allowFlight && toggle('allowFlight', 'mc.allowFlight')}
          {has.allowCheats && toggle('allowCheats', 'mc.allowCheats')}
          {has.commandBlocks && toggle('commandBlocks', 'mc.commandBlocks')}
          {has.allowNether && toggle('allowNether', 'mc.allowNether')}
          {has.spawnMobs && toggle('spawnAnimals', 'mc.spawnAnimals')}
          {has.spawnMobs && toggle('spawnMonsters', 'mc.spawnMonsters')}
          {has.spawnMobs && toggle('spawnNpcs', 'mc.spawnNpcs')}
        </ToggleGrid>
        {!bedrock && <LanAnnounceField checked={lanAnnounce} onChange={onLanAnnounce} />}
        {!form.onlineMode && <Note>{t('mc.offlineWarning')}</Note>}
        {form.hardcore && has.hardcore && <Note>{t('mc.hardcoreNote')}</Note>}
      </Group>

      <Group title={t('mc.section.world')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('mc.seed')} error={errors.seed} hint={t('mc.seedHint')}>
            <input
              className="input font-mono"
              value={form.seed}
              maxLength={64}
              placeholder={t('mc.seedPlaceholder')}
              onChange={(e) => set('seed', e.target.value)}
              aria-invalid={!!errors.seed}
              spellCheck={false}
            />
          </Field>
          <Field label={t('mc.levelType')}>
            <select className="input" value={form.levelType} onChange={(e) => set('levelType', e.target.value as McForm['levelType'])}>
              {levelTypes.map((m) => (
                <option key={m} value={m}>
                  {t(`mc.levelType.${m}` as TKey)}
                </option>
              ))}
            </select>
          </Field>
          {has.spawnProtection && numberField('spawnProtection', 'mc.spawnProtection', t('mc.spawnProtectionHint'))}
          {has.maxWorldSize && numberField('maxWorldSize', 'mc.maxWorldSize', t('mc.maxWorldSizeHint'))}
        </div>
        {has.generatorSettings && form.levelType === 'flat' && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{t('mc.flatPreset')}</span>
              {FLAT_PRESETS.map((p) => (
                <Button key={p.id} size="sm" onClick={() => set('generatorSettings', p.json)} aria-pressed={form.generatorSettings === p.json}>
                  {t(`mc.flatPreset.${p.id}` as TKey)}
                </Button>
              ))}
            </div>
          </div>
        )}
        {has.generatorSettings && form.levelType === 'single_biome_surface' && (
          <Field label={t('mc.biome')}>
            <select
              className="input"
              value={/"minecraft:([a-z_]+)"/.exec(form.generatorSettings)?.[1] ?? ''}
              onChange={(e) => set('generatorSettings', e.target.value ? JSON.stringify({ biome: `minecraft:${e.target.value}` }) : '')}
            >
              <option value="">{t('mc.biomeDefault')}</option>
              {SINGLE_BIOMES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </Field>
        )}
        {has.generatorSettings && (form.levelType === 'flat' || form.levelType === 'single_biome_surface') && (
          <Field label={t('mc.generatorSettings')} error={errors.generatorSettings} hint={t('mc.generatorSettingsHint')}>
            <textarea
              className="input min-h-[5rem] font-mono text-xs"
              value={form.generatorSettings}
              onChange={(e) => set('generatorSettings', e.target.value)}
              placeholder='{"layers":[...],"biome":"minecraft:plains"}'
              spellCheck={false}
              aria-invalid={!!errors.generatorSettings}
            />
          </Field>
        )}
        {has.generateStructures && <ToggleGrid>{toggle('generateStructures', 'mc.generateStructures')}</ToggleGrid>}
        {form.levelType === 'single_biome_surface' && <Note>{t('mc.singleBiomeNote')}</Note>}
      </Group>

      <Group title={t('mc.section.whitelist')}>
        <ToggleGrid>
          {toggle('whitelistEnabled', bedrock ? 'mc.allowList' : 'mc.whitelist')}
          {has.whitelistEnforce && form.whitelistEnabled && toggle('whitelistEnforce', 'mc.whitelistEnforce')}
        </ToggleGrid>
        {form.whitelistEnabled && (
          <ChipInput
            label={t('mc.whitelistUsers')}
            value={form.whitelistUsers}
            onChange={(v) => set('whitelistUsers', v)}
            pattern={bedrock ? BEDROCK_PLAYER : JAVA_PLAYER}
            placeholder={bedrock ? 'Gamertag' : 'Notch, jeb_'}
            hint={bedrock ? t('mc.whitelistUsersHintBedrock') : t('mc.whitelistUsersHint')}
          />
        )}
        <ChipInput
          label={t('mc.ops')}
          value={form.ops}
          onChange={(v) => set('ops', v)}
          pattern={bedrock ? BEDROCK_PLAYER : JAVA_PLAYER}
          placeholder={bedrock ? 'Gamertag / XUID' : 'Notch'}
          hint={bedrock ? t('mc.opsHintBedrock') : t('mc.opsHint')}
        />
      </Group>

      <Group title={t('mc.section.performance')} collapsible defaultOpen={false}>
        <div className="grid gap-4 sm:grid-cols-2">
          {numberField('viewDistance', 'mc.viewDistance', t('mc.chunksHint', { min: 3, max: 32 }))}
          {has.simulationDistance && numberField('simulationDistance', 'mc.simulationDistance', t('mc.chunksHint', { min: 3, max: 32 }))}
          {has.tickDistance && numberField('tickDistance', 'mc.tickDistance', t('mc.chunksHint', { min: 4, max: 12 }))}
          {has.entityBroadcastRange && numberField('entityBroadcastRange', 'mc.entityBroadcastRange', t('mc.percentHint', { min: 10, max: 1000 }))}
          {numberField('networkCompressionThreshold', 'mc.networkCompressionThreshold', bedrock ? t('mc.compressionHintBedrock') : t('mc.compressionHint'))}
        </div>
      </Group>

      <Group title={t('mc.section.resourcePack')} collapsible defaultOpen={false}>
        {has.resourcePackUrl ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('mc.resourcePackUrl')} error={errors.resourcePackUrl} className="sm:col-span-2">
              <input
                className="input"
                type="url"
                inputMode="url"
                value={form.resourcePackUrl}
                placeholder="https://example.com/pack.zip"
                onChange={(e) => set('resourcePackUrl', e.target.value)}
                aria-invalid={!!errors.resourcePackUrl}
              />
            </Field>
            <Field label={t('mc.resourcePackSha1')} error={errors.resourcePackSha1} hint={t('mc.resourcePackSha1Hint')} className="sm:col-span-2">
              <input
                className="input font-mono text-xs"
                value={form.resourcePackSha1}
                maxLength={40}
                placeholder="0123456789abcdef0123456789abcdef01234567"
                onChange={(e) => set('resourcePackSha1', e.target.value)}
                aria-invalid={!!errors.resourcePackSha1}
                spellCheck={false}
              />
            </Field>
          </div>
        ) : (
          <Note>{t('mc.bedrockPackNote')}</Note>
        )}
        <ToggleGrid>{toggle('resourcePackRequired', 'mc.resourcePackRequired')}</ToggleGrid>
      </Group>

      <Group title={t('mc.section.advanced')} collapsible defaultOpen={form.extra.length > 0}>
        <p className="text-sm text-muted">{bedrock ? t('mc.extraHintBedrock') : t('mc.extraHint')}</p>
        {form.extra.length > 0 && (
          <ul className="space-y-2">
            {form.extra.map((row, i) => {
              const err = errors[`extra.${i}`];
              return (
                <li key={i}>
                  <div className="flex items-start gap-2">
                    <input
                      className={clsx('input min-w-0 flex-1 font-mono text-xs', err && 'border-danger')}
                      value={row.key}
                      placeholder={bedrock ? 'content-log-level' : 'pause-when-empty-seconds'}
                      aria-label={t('mc.extraKey')}
                      aria-invalid={!!err}
                      spellCheck={false}
                      autoCapitalize="off"
                      onChange={(e) => set('extra', form.extra.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                    />
                    <span className="pt-2 text-muted" aria-hidden="true">
                      =
                    </span>
                    <input
                      className={clsx('input min-w-0 flex-1 font-mono text-xs', err && 'border-danger')}
                      value={row.value}
                      placeholder={bedrock ? 'info' : '60'}
                      aria-label={t('mc.extraValue')}
                      spellCheck={false}
                      onChange={(e) => set('extra', form.extra.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                    />
                    <IconButton label={t('common.delete')} className="mt-1 shrink-0" onClick={() => set('extra', form.extra.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                  {err && <span className="mt-1 block text-xs text-danger">{err}</span>}
                </li>
              );
            })}
          </ul>
        )}
        <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => set('extra', [...form.extra, { key: '', value: '' }])} disabled={form.extra.length >= 50}>
          {t('mc.addProperty')}
        </Button>
      </Group>
    </div>
  );
}
