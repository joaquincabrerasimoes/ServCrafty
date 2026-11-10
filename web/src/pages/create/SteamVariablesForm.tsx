import { useId, useState, type ReactNode } from 'react';
import { Copy, Eye, EyeOff, RefreshCw } from 'lucide-react';
import type { GameVariable } from '@/api/types';
import { useT } from '@/i18n';
import { toast } from '@/stores/toast';
import { copy } from '@/components/CopyAddress';
import { Button, Field, IconButton, Toggle } from '@/components/ui';
import { groupVariables, isGenerated, type SteamErrors, type SteamForm } from './steamForm';

function GroupPanel({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="panel min-w-0" aria-labelledby={id}>
      <h3 id={id} className="border-b border-line px-4 py-3 text-base font-semibold sm:px-5">
        {title}
      </h3>
      <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5">{children}</div>
    </section>
  );
}

function PasswordInput({
  value,
  onChange,
  hidden,
  invalid,
  disabled,
  describedBy,
  copyable,
}: {
  value: string;
  onChange: (v: string) => void;
  /** The API blanked the stored secret for this user: show a placeholder, keep it unless typed over. */
  hidden?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  describedBy?: string;
  /** Adds a copy button (generated secrets in Settings). */
  copyable?: boolean;
}) {
  const t = useT();
  const [show, setShow] = useState(false);
  return (
    <span className="relative block">
      <input
        className={copyable ? 'input pe-20 font-mono' : 'input pe-11 font-mono'}
        type={show ? 'text' : 'password'}
        value={value}
        autoComplete="new-password"
        spellCheck={false}
        autoCapitalize="none"
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        placeholder={hidden ? t('steam.secretHidden') : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      <IconButton
        label={show ? t('steam.hideSecret') : t('steam.showSecret')}
        className="absolute end-1 top-1/2 -translate-y-1/2"
        disabled={disabled}
        onClick={(e) => {
          e.preventDefault();
          setShow((s) => !s);
        }}
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </IconButton>
      {copyable && (
        <IconButton
          label={t('common.copy')}
          className="absolute end-10 top-1/2 -translate-y-1/2"
          disabled={disabled || !value}
          onClick={(e) => {
            e.preventDefault();
            void copy(value).then((ok) => ok && toast.info(t('common.copied')));
          }}
        >
          <Copy className="h-4 w-4" />
        </IconButton>
      )}
    </span>
  );
}

function VariableField({
  v,
  value,
  onChange,
  error,
  hidden,
  disabled,
  mode,
  onRegenerate,
}: {
  v: GameVariable;
  value: string | boolean | undefined;
  onChange: (v: string | boolean) => void;
  error?: string;
  hidden?: boolean;
  disabled?: boolean;
  mode: 'create' | 'edit';
  onRegenerate?: () => void;
}) {
  const t = useT();
  const generated = isGenerated(v);
  const required = v.required && !generated;
  const label = (
    <>
      {v.label || v.key}
      {required && (
        <span className="text-danger" aria-hidden="true">
          {' '}
          *
        </span>
      )}
      {required && <span className="sr-only"> ({t('steam.required')})</span>}
    </>
  );
  const hint =
    [
      v.description,
      v.type === 'number' && (v.min !== undefined || v.max !== undefined) ? rangeHint(v, t) : null,
      generated ? (mode === 'edit' ? t('steam.generatedEditHint') : t('steam.generatedHint')) : null,
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  if (v.type === 'boolean') {
    return (
      <div className="sm:col-span-2">
        <Toggle checked={value === true} onChange={onChange} disabled={disabled} label={v.label || v.key} />
        {hint && <p className="hint">{hint}</p>}
      </div>
    );
  }

  const str = typeof value === 'string' ? value : '';
  const wide = v.type === 'string' && (v.max === undefined || v.max > 40);
  // Settings: a generated value is shown masked with reveal + copy, and can be regenerated.
  if (generated && mode === 'edit' && !hidden) {
    return (
      <div className={wide || onRegenerate ? 'sm:col-span-2' : undefined}>
        <Field label={label} hint={hint} error={error}>
          <PasswordInput value={str} onChange={onChange} invalid={!!error} disabled={disabled} copyable />
        </Field>
        {onRegenerate && (
          <Button size="sm" variant="ghost" className="mt-1" disabled={disabled} onClick={onRegenerate} icon={<RefreshCw className="h-4 w-4" />}>
            {t('steam.generateNew')}
          </Button>
        )}
      </div>
    );
  }
  return (
    <Field label={label} hint={hidden && !str ? `${t('steam.secretHiddenHint')}${hint ? ` ${hint}` : ''}` : hint} error={error} className={wide ? 'sm:col-span-2' : undefined}>
      {v.type === 'select' ? (
        <select className="input" value={str} disabled={disabled} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)}>
          {(!v.required || !str) && <option value="">{v.required ? t('steam.choose') : t('steam.notSet')}</option>}
          {(v.options ?? []).map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label ?? String(o.value)}
            </option>
          ))}
        </select>
      ) : v.type === 'password' ? (
        <PasswordInput value={str} onChange={onChange} hidden={hidden} invalid={!!error} disabled={disabled} />
      ) : v.type === 'number' ? (
        <input
          className="input"
          type="number"
          inputMode="decimal"
          min={v.min}
          max={v.max}
          value={str}
          disabled={disabled}
          aria-invalid={!!error}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="input"
          value={str}
          maxLength={v.max}
          disabled={disabled}
          spellCheck={false}
          aria-invalid={!!error}
          placeholder={generated ? t('steam.generatedPlaceholder') : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

function rangeHint(v: GameVariable, t: ReturnType<typeof useT>) {
  if (v.min !== undefined && v.max !== undefined) return t('mc.rangeHint', { min: v.min, max: v.max });
  if (v.min !== undefined) return t('steam.minHint', { min: v.min });
  return t('steam.maxHint', { max: v.max ?? '' });
}

/**
 * Form generated from a game definition's `variables`, grouped by `group` (one panel per group).
 * Shared by the create wizard, the server Settings tab and the admin "Form preview".
 */
export function SteamVariablesForm({
  variables,
  values,
  onChange,
  errors = {},
  hiddenSecrets,
  disabled,
  footer,
  mode = 'create',
  onRegenerate,
}: {
  variables: GameVariable[];
  values: SteamForm;
  onChange: (key: string, value: string | boolean) => void;
  errors?: SteamErrors;
  /** Password variables whose stored value the API did not reveal to this user. */
  hiddenSecrets?: Set<string>;
  disabled?: boolean;
  /** Extra content in a final "Game files" panel (e.g. the update-on-start toggle). */
  footer?: ReactNode;
  /** 'edit' (server Settings) shows generated values with copy and "Generate new". */
  mode?: 'create' | 'edit';
  /** Settings: replace a generated variable's value. */
  onRegenerate?: (key: string) => void;
}) {
  const t = useT();
  const groups = groupVariables(variables);
  return (
    <div className="space-y-4">
      {groups.length === 0 && !footer && <p className="panel px-4 py-6 text-center text-sm text-muted">{t('steam.noVariables')}</p>}
      {groups.map((g) => (
        <GroupPanel key={g.group ?? ''} title={g.group ?? t('steam.groupGeneral')}>
          {g.vars.map((v) => (
            <VariableField
              key={v.key}
              v={v}
              value={values[v.key]}
              onChange={(val) => onChange(v.key, val)}
              error={errors[v.key]}
              hidden={(v.type === 'password' || isGenerated(v)) && hiddenSecrets?.has(v.key)}
              disabled={disabled}
              mode={mode}
              onRegenerate={onRegenerate && isGenerated(v) ? () => onRegenerate(v.key) : undefined}
            />
          ))}
        </GroupPanel>
      ))}
      {footer && (
        <section className="panel min-w-0 space-y-3 p-4 sm:p-5">
          <h3 className="text-base font-semibold">{t('steam.gameFiles')}</h3>
          {footer}
        </section>
      )}
    </div>
  );
}
