import { useId, useRef, type ReactNode } from 'react';
import { FileUp, Info, X } from 'lucide-react';
import { TERRARIA_LANGUAGES, type ServerType, type TerrariaLanguage } from '@/api/types';
import { useT } from '@/i18n';
import { formatBytes } from '@/lib/format';
import { Button, Field, IconButton, Toggle } from '@/components/ui';
import { MAX_WORKSHOP_MODS, TR_DIFFICULTIES, TR_LANGUAGE_NAMES, TR_SIZES, parseWorkshopIds, type TrErrors, type TrForm } from './terrariaForm';

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="panel min-w-0" aria-labelledby={id}>
      <h3 id={id} className="border-b border-line px-4 py-3 text-base font-semibold sm:px-5">
        {title}
      </h3>
      <div className="space-y-4 p-4 sm:p-5">{children}</div>
    </section>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 rounded-block border border-line bg-raised px-3 py-2 text-xs text-muted">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** Picker for a world import: one .wld, plus its .twld companion for tModLoader. */
export function WorldFilePicker({
  files,
  onChange,
  type,
  error,
  disabled,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  type: ServerType;
  error?: string | null;
  disabled?: boolean;
}) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const tml = type === 'TMODLOADER';
  return (
    <div>
      <span className="label" id={`${id}-label`}>
        {t('tr.importWorld')}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => input.current?.click()}
          disabled={disabled}
          icon={<FileUp className="h-4 w-4" />}
          aria-describedby={`${id}-msg`}
        >
          {files.length ? t('tr.importChange') : t('tr.importChoose')}
        </Button>
        <input
          ref={input}
          type="file"
          hidden
          multiple={tml}
          accept={tml ? '.wld,.twld' : '.wld'}
          aria-labelledby={`${id}-label`}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (picked.length) onChange(picked);
          }}
        />
        {files.length > 0 && (
          <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label={t('tr.importWorld')}>
            {files.map((f) => (
              <li key={f.name} className="inline-flex max-w-full items-center gap-1 rounded-[2px] border border-line bg-raised py-0.5 pe-0.5 ps-2 text-sm">
                <span className="truncate font-mono text-[13px]">{f.name}</span>
                <span className="text-xs text-muted">{formatBytes(f.size)}</span>
                <IconButton
                  label={t('tr.removeFile', { name: f.name })}
                  className="h-6 w-6"
                  disabled={disabled}
                  onClick={() => onChange(files.filter((x) => x !== f))}
                >
                  <X className="h-3.5 w-3.5" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </div>
      <span id={`${id}-msg`} className={error ? 'mt-1 block text-xs text-danger' : 'hint block'} role={error ? 'alert' : undefined}>
        {error ?? (tml ? t('tr.importHintTml') : t('tr.importHint'))}
      </span>
    </div>
  );
}

/**
 * Terraria config fields, shared by the create wizard and the Settings tab.
 * `worldLocked` disables the world creation fields (the world file already exists or one is
 * being imported) and shows `worldLockedHint` instead.
 */
export function TerrariaConfigFields({
  form,
  set,
  errors,
  type,
  worldLocked,
  worldLockedHint,
  worldSlot,
}: {
  form: TrForm;
  set: <K extends keyof TrForm>(k: K, v: TrForm[K]) => void;
  errors: TrErrors;
  type: ServerType;
  worldLocked?: boolean;
  worldLockedHint?: ReactNode;
  /** Extra content at the top of the World group (the wizard's world import picker). */
  worldSlot?: ReactNode;
}) {
  const t = useT();
  const modCount = type === 'TMODLOADER' ? parseWorkshopIds(form.workshopMods).length : 0;
  return (
    <div className="space-y-4">
      <Group title={t('tr.section.world')}>
        {worldSlot}
        {worldLocked && worldLockedHint && <Note>{worldLockedHint}</Note>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('tr.worldName')} hint={t('tr.worldNameHint')} error={errors.worldName} className="sm:col-span-2">
            <input
              className="input"
              value={form.worldName}
              maxLength={32}
              disabled={worldLocked}
              aria-invalid={!!errors.worldName}
              onChange={(e) => set('worldName', e.target.value)}
            />
          </Field>
          <Field label={t('tr.size')}>
            <select className="input" value={form.size} disabled={worldLocked} onChange={(e) => set('size', Number(e.target.value) as TrForm['size'])}>
              {TR_SIZES.map((s) => (
                <option key={s} value={s}>
                  {t(`tr.size.${s}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('tr.difficulty')} hint={t(`tr.difficultyHint.${form.difficulty}`)}>
            <select
              className="input"
              value={form.difficulty}
              disabled={worldLocked}
              onChange={(e) => set('difficulty', Number(e.target.value) as TrForm['difficulty'])}
            >
              {TR_DIFFICULTIES.map((d) => (
                <option key={d} value={d}>
                  {t(`tr.difficulty.${d}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('tr.seed')} hint={t('tr.seedHint')} error={errors.seed} className="sm:col-span-2">
            <input
              className="input font-mono"
              value={form.seed}
              maxLength={40}
              disabled={worldLocked}
              placeholder={t('tr.seedRandom')}
              aria-invalid={!!errors.seed}
              onChange={(e) => set('seed', e.target.value)}
            />
          </Field>
        </div>
      </Group>

      <Group title={t('tr.section.game')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('tr.maxPlayers')} error={errors.maxPlayers} hint={t('mc.rangeHint', { min: 1, max: 255 })}>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              min={1}
              max={255}
              value={form.maxPlayers}
              aria-invalid={!!errors.maxPlayers}
              onChange={(e) => set('maxPlayers', e.target.value)}
            />
          </Field>
          <Field label={t('tr.password')} hint={t('tr.passwordHint')} error={errors.password}>
            <input
              className="input"
              value={form.password}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('tr.passwordNone')}
              aria-invalid={!!errors.password}
              onChange={(e) => set('password', e.target.value)}
            />
          </Field>
          <Field label={t('tr.motd')} hint={t('tr.motdHint')} error={errors.motd} className="sm:col-span-2">
            <input className="input" value={form.motd} maxLength={100} aria-invalid={!!errors.motd} onChange={(e) => set('motd', e.target.value)} />
          </Field>
          <Field label={t('tr.language')} hint={t('tr.languageHint')}>
            <select className="input" value={form.language} onChange={(e) => set('language', e.target.value as TerrariaLanguage | '')}>
              <option value="">{t('tr.languageDefault')}</option>
              {TERRARIA_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {TR_LANGUAGE_NAMES[l]}
                </option>
              ))}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Toggle checked={form.secure} onChange={(v) => set('secure', v)} label={t('tr.secure')} />
            <p className="hint">{t('tr.secureHint')}</p>
          </div>
        </div>
      </Group>

      {type === 'TMODLOADER' && (
        <Group title={t('tr.workshopMods')}>
          <Field
            label={t('tr.workshopIds')}
            error={errors.workshopMods}
            hint={`${t('tr.workshopHint')} ${t('tr.workshopCount', { n: modCount, max: MAX_WORKSHOP_MODS })}`}
          >
            <textarea
              className="input min-h-[7rem] font-mono"
              value={form.workshopMods}
              spellCheck={false}
              placeholder={'2824688072\n2824688266'}
              aria-invalid={!!errors.workshopMods}
              onChange={(e) => set('workshopMods', e.target.value)}
            />
          </Field>
        </Group>
      )}
    </div>
  );
}
