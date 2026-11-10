import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, ArrowLeft, BookOpen, CheckCircle2, Copy, Download, Loader2, Lock, Save } from 'lucide-react';
import { ApiError, gamesApi, toIssues, type ValidateResult } from '@/api';
import type { ValidationIssue } from '@/api/types';
import { useT } from '@/i18n';
import { GAME_ID_RE, gamesKey, useGameDefs } from '@/lib/gameDefs';
import { toast } from '@/stores/toast';
import { TextEditor } from '@/components/TextEditor';
import { Badge, Button, ErrorState, Loading, PageHeader, Toggle } from '@/components/ui';
import { SteamVariablesForm } from '../create/SteamVariablesForm';
import { cleanVariables, steamDefaults, validateSteam, type SteamForm } from '../create/steamForm';
import { NEW_GAME_TEMPLATE, REF_EXAMPLES, downloadJson, jsonErrorLocation, previewArgv, toJson } from './gameAuthoring';
import { stripMeta, type NewGameState } from './Games';

type Parsed = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

function parse(text: string, t: ReturnType<typeof useT>): Parsed {
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: t('games.notObject') };
    return { ok: true, value: v as Record<string, unknown> };
  } catch (e) {
    const loc = jsonErrorLocation(text, e);
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: loc ? t('games.jsonErrorAt', { line: loc.line, col: loc.col, error: msg }) : msg };
  }
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

type Validation = { state: 'idle' } | { state: 'checking' } | { state: 'done'; result: ValidateResult } | { state: 'error'; error: unknown };

/** Debounced live validation through POST /games/validate (after a local JSON parse). */
function useValidation(parsed: Parsed): Validation {
  const debounced = useDebounced(parsed, 600);
  const [v, setV] = useState<Validation>({ state: 'idle' });
  const pending = parsed !== debounced;
  useEffect(() => {
    if (!debounced.ok) {
      setV({ state: 'idle' });
      return;
    }
    const ctl = new AbortController();
    setV({ state: 'checking' });
    gamesApi
      .validate(debounced.value, ctl.signal)
      .then((result) => setV({ state: 'done', result }))
      .catch((error) => {
        if ((error as Error)?.name !== 'AbortError') setV({ state: 'error', error });
      });
    return () => ctl.abort();
  }, [debounced]);
  return pending && parsed.ok ? { state: 'checking' } : v;
}

function Ref({ title, children, code }: { title: string; children: ReactNode; code?: string }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-sm font-semibold">{title}</h4>
      <p className="text-sm text-muted">{children}</p>
      {code && <pre className="scrollbar-thin overflow-x-auto rounded-block bg-raised p-2 font-mono text-[12px] leading-relaxed">{code}</pre>}
    </div>
  );
}

function AuthoringReference() {
  const t = useT();
  return (
    <details className="panel group">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold sm:px-5">
        <BookOpen className="h-4 w-4 text-accent" aria-hidden="true" />
        {t('games.refTitle')}
        <span className="ms-auto text-xs font-normal text-muted group-open:hidden">{t('games.refShow')}</span>
      </summary>
      <div className="space-y-5 border-t border-line px-4 py-4 sm:px-5">
        <p className="text-sm text-muted">{t('games.refIntro')}</p>
        <Ref title={t('games.ref.templates')} code={REF_EXAMPLES.template}>
          {t('games.ref.templatesBody')}
        </Ref>
        <Ref title={t('games.ref.ports')} code={REF_EXAMPLES.ports}>
          {t('games.ref.portsBody')}
        </Ref>
        <Ref title={t('games.ref.variables')} code={REF_EXAMPLES.variables}>
          {t('games.ref.variablesBody')}
        </Ref>
        <Ref title={t('games.ref.launch')} code={REF_EXAMPLES.launch}>
          {t('games.ref.launchBody')}
        </Ref>
        <Ref title={t('games.ref.composite')} code={REF_EXAMPLES.composite}>
          {t('games.ref.compositeBody')}
        </Ref>
        <Ref title={t('games.ref.generate')} code={REF_EXAMPLES.generate}>
          {t('games.ref.generateBody')}
        </Ref>
        <Ref title={t('games.ref.files')} code={REF_EXAMPLES.files}>
          {t('games.ref.filesBody')}
        </Ref>
        <Ref title={t('games.ref.lifecycle')} code={REF_EXAMPLES.lifecycle}>
          {t('games.ref.lifecycleBody')}
        </Ref>
        <Ref title={t('games.ref.players')} code={REF_EXAMPLES.players}>
          {t('games.ref.playersBody')}
        </Ref>
        <Ref title={t('games.ref.workshop')} code={REF_EXAMPLES.workshop}>
          {t('games.ref.workshopBody')}
        </Ref>
        <Ref title={t('games.ref.webui')} code={REF_EXAMPLES.webui}>
          {t('games.ref.webuiBody')} {t('games.ref.webuiWebsocket')}
        </Ref>
        <p className="text-sm text-muted">
          {t('games.refMore')} <span className="font-mono text-ink">docs/games.md</span>
        </p>
      </div>
    </details>
  );
}

function FormPreview({ value }: { value: Record<string, unknown> | null }) {
  const t = useT();
  const vars = useMemo(() => cleanVariables(value?.variables), [value]);
  const [vals, setVals] = useState<SteamForm>(() => steamDefaults(vars));
  const [update, setUpdate] = useState(true);
  // New variables (or changed defaults) reset the preview values.
  const sig = JSON.stringify(vars.map((v) => [v.key, v.type, v.default]));
  useEffect(() => setVals(steamDefaults(vars)), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const errors = useMemo(() => validateSteam(vars, vals, t), [vars, vals, t]);
  const argv = useMemo(() => (value ? previewArgv(value, vals) : null), [value, vals]);
  if (!value) return <p className="panel px-4 py-6 text-center text-sm text-muted">{t('games.previewNeedsJson')}</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">{t('games.previewBody')}</p>
      <SteamVariablesForm
        variables={vars}
        values={vals}
        onChange={(k, v) => setVals((f) => ({ ...f, [k]: v }))}
        errors={errors}
        footer={
          <div>
            <Toggle checked={update} onChange={setUpdate} label={t('steam.updateOnStart')} />
            <p className="hint">{t('steam.updateOnStartHint')}</p>
          </div>
        }
      />
      <section className="panel space-y-2 p-4 sm:p-5" aria-labelledby="argv-preview">
        <h3 id="argv-preview" className="text-base font-semibold">
          {t('games.argvTitle')}
        </h3>
        <p className="text-sm text-muted">{t('games.argvBody')}</p>
        {argv ? (
          <ol className="flex flex-wrap gap-1.5">
            {argv.map((a, i) => (
              <li key={i} className="max-w-full break-all rounded-[2px] border border-line bg-raised px-1.5 py-0.5 font-mono text-[12px]">
                {a === '' ? '""' : a}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted">{t('games.argvNone')}</p>
        )}
      </section>
    </div>
  );
}

function IssueList({ issues }: { issues: ValidationIssue[] }) {
  return (
    <ul className="space-y-1 text-sm">
      {issues.map((i, n) => (
        <li key={n} className="flex min-w-0 gap-2">
          {i.path && <code className="shrink-0 rounded-[2px] bg-raised px-1 font-mono text-xs leading-5 text-ink">{i.path}</code>}
          <span className="min-w-0 break-words text-danger">{i.message}</span>
        </li>
      ))}
    </ul>
  );
}

export default function GameEditor() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const location = useLocation();
  const { id: routeId = 'new' } = useParams();
  const isNew = routeId === 'new';
  const defs = useGameDefs();
  const summary = defs.data?.find((d) => d.id === routeId);
  const builtin = !isNew && !!summary?.builtin;
  const full = useQuery({ queryKey: ['games', routeId, 'full'], queryFn: () => gamesApi.get(routeId), enabled: !isNew, staleTime: 0 });

  const initial = useMemo(() => {
    if (isNew) return (location.state as NewGameState | null)?.text ?? toJson(NEW_GAME_TEMPLATE);
    return full.data ? toJson(stripMeta(full.data as unknown as Record<string, unknown>)) : null;
  }, [isNew, location.state, full.data]);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (initial !== null) setText((cur) => cur ?? initial);
  }, [initial]);
  const [tab, setTab] = useState<'json' | 'preview'>('json');
  const [saving, setSaving] = useState(false);
  const [saveIssues, setSaveIssues] = useState<ValidationIssue[]>([]);

  const parsed = useMemo<Parsed>(() => parse(text ?? '{}', t), [text, t]);
  const validation = useValidation(parsed);
  const idValue = parsed.ok ? parsed.value.id : undefined;
  const idProblem = !parsed.ok
    ? null
    : typeof idValue !== 'string' || !GAME_ID_RE.test(idValue)
      ? t('games.idInvalid')
      : !isNew && idValue !== routeId
        ? t('games.idChanged', { id: routeId })
        : isNew && defs.data?.some((d) => d.id === idValue)
          ? t('games.idTaken', { id: idValue })
          : null;
  const valid = parsed.ok && validation.state === 'done' && validation.result.ok && !idProblem;
  const dirty = text !== null && text !== initial;

  if (!isNew && (full.isLoading || defs.isLoading)) return <Loading />;
  if (!isNew && full.error) return <ErrorState error={full.error} onRetry={() => void full.refetch()} />;
  if (text === null) return <Loading />;

  const save = async () => {
    if (!valid || !parsed.ok || builtin) return;
    setSaving(true);
    setSaveIssues([]);
    try {
      const saved = isNew ? await gamesApi.create(parsed.value) : await gamesApi.update(routeId, parsed.value);
      await qc.invalidateQueries({ queryKey: gamesKey });
      toast.success(t('games.saved', { name: String(parsed.value.name ?? idValue) }));
      const newId = saved?.id ?? String(idValue);
      if (isNew) {
        navigate(`/admin/games/${encodeURIComponent(newId)}`, { replace: true });
        setText(null); // reloads from the saved definition
      }
      else setText(toJson(stripMeta((saved ?? parsed.value) as unknown as Record<string, unknown>)));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_game_definition') setSaveIssues(toIssues(e.details));
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  const duplicate = () => {
    if (!parsed.ok) return;
    const id = `${String(idValue ?? 'game').slice(0, 35)}-copy`;
    navigate('/admin/games/new', { state: { text: toJson({ ...parsed.value, id, name: t('games.copyName', { name: String(parsed.value.name ?? '') }) }) } satisfies NewGameState });
    setText(null);
  };

  const issues = validation.state === 'done' && !validation.result.ok ? validation.result.issues : saveIssues;
  const title = isNew ? t('games.newTitle') : builtin ? t('games.viewTitle', { name: summary?.name ?? routeId }) : t('games.editTitle', { name: summary?.name ?? routeId });

  return (
    <>
      <Link to="/admin/games" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
        {t('games.back')}
      </Link>
      <PageHeader
        title={title}
        subtitle={builtin ? t('games.builtinReadOnly') : t('games.editorSubtitle')}
        actions={
          <>
            {!isNew && (
              <Button onClick={() => parsed.ok && downloadJson(`${routeId}.json`, parsed.value)} disabled={!parsed.ok} icon={<Download className="h-4 w-4" />}>
                {t('games.export')}
              </Button>
            )}
            {!isNew && (
              <Button onClick={duplicate} disabled={!parsed.ok} icon={<Copy className="h-4 w-4" />}>
                {t('games.duplicate')}
              </Button>
            )}
            {!builtin && (
              <Button variant="primary" loading={saving} disabled={!valid || (!isNew && !dirty)} onClick={() => void save()} icon={<Save className="h-4 w-4" />}>
                {t('common.save')}
              </Button>
            )}
          </>
        }
      />

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex rounded-block border border-line bg-surface p-0.5" role="tablist" aria-label={t('games.editorTabs')}>
            {(['json', 'preview'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={clsx('h-8 rounded-[2px] px-3 text-sm', tab === k ? 'bg-raised font-medium text-ink' : 'text-muted hover:text-ink')}
              >
                {k === 'json' ? t('games.tabJson') : t('games.tabPreview')}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-sm" aria-live="polite">
            {builtin && (
              <Badge>
                <Lock className="h-3 w-3" aria-hidden="true" />
                {t('games.readOnly')}
              </Badge>
            )}
            {!parsed.ok ? (
              <span className="inline-flex items-center gap-1.5 text-danger">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                {t('games.statusJson')}
              </span>
            ) : validation.state === 'checking' || validation.state === 'idle' ? (
              <span className="inline-flex items-center gap-1.5 text-muted">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('games.statusChecking')}
              </span>
            ) : validation.state === 'error' ? (
              <span className="inline-flex items-center gap-1.5 text-warn">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                {t('games.statusUnavailable')}
              </span>
            ) : validation.result.ok && !idProblem ? (
              <span className="inline-flex items-center gap-1.5 text-ok">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                {t('games.statusValid')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-danger">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                {t('games.statusInvalid', { n: (validation.result.ok ? 0 : validation.result.issues.length) + (idProblem ? 1 : 0) })}
              </span>
            )}
          </div>
        </div>

        {tab === 'json' ? (
          <div className="h-[60dvh] min-h-[20rem]">
            <TextEditor value={text} onChange={setText} onSave={() => void save()} readOnly={builtin} />
          </div>
        ) : (
          <FormPreview value={parsed.ok ? parsed.value : null} />
        )}

        {(!parsed.ok || idProblem || issues.length > 0 || validation.state === 'error') && (
          <section className="rounded-md border border-danger/30 bg-danger/5 p-4" aria-labelledby="game-issues">
            <h2 id="game-issues" className="mb-2 text-sm font-semibold">
              {t('games.issuesTitle')}
            </h2>
            {!parsed.ok ? (
              <p className="break-words text-sm text-danger">{parsed.error}</p>
            ) : (
              <div className="space-y-2">
                {idProblem && <IssueList issues={[{ path: 'id', message: idProblem }]} />}
                {issues.length > 0 && <IssueList issues={issues} />}
                {validation.state === 'error' && <p className="text-sm text-warn">{t('games.validateFailed', { error: (validation.error as Error)?.message ?? '' })}</p>}
              </div>
            )}
          </section>
        )}

        <AuthoringReference />
      </div>
    </>
  );
}
