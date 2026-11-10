import { useEffect, useId, useState } from 'react';
import clsx from 'clsx';
import { useT } from '@/i18n';
import type { AdminGame } from '@/api/types';
import { Button, Modal } from '@/components/ui';

/**
 * Confirm dialog for turning a game off (or changing how an already disabled game is disabled).
 * "Only block new servers" is the default; "Also stop and block starting" is the dangerous one.
 */
export function DisableGameDialog({
  game,
  busy,
  onClose,
  onConfirm,
}: {
  game: AdminGame | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (blockStart: boolean) => void;
}) {
  const t = useT();
  const name = useId();
  const [block, setBlock] = useState(false);
  useEffect(() => {
    if (game) setBlock(game.disabled ? game.blockStart : false);
  }, [game]);
  if (!game) return null;
  const change = game.disabled;

  const option = (value: boolean, title: string, body: string, danger?: boolean) => (
    <label
      className={clsx(
        'flex cursor-pointer items-start gap-3 rounded-block border p-3 text-sm',
        block === value ? (danger ? 'border-danger bg-danger/5' : 'border-accent bg-accent/5') : 'border-line hover:bg-raised',
      )}
    >
      <input type="radio" name={name} className={clsx('mt-0.5 h-4 w-4 shrink-0', danger ? 'accent-[rgb(var(--danger))]' : 'accent-[rgb(var(--accent))]')} checked={block === value} onChange={() => setBlock(value)} />
      <span>
        <span className={clsx('block font-medium', danger && 'text-danger')}>{title}</span>
        <span className="mt-0.5 block text-muted">{body}</span>
      </span>
    </label>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={change ? t('games.disableChangeTitle', { name: game.name }) : t('games.disableTitle', { name: game.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant={block ? 'danger' : 'primary'} loading={busy} onClick={() => onConfirm(block)} data-autofocus>
            {block ? t('games.disableBlockConfirm') : change ? t('common.save') : t('games.disableConfirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">{t('games.disableBody')}</p>
        <dl className="grid grid-cols-2 gap-3">
          <div className="rounded-block border border-line px-3 py-2">
            <dt className="text-xs text-muted">{t('games.disableServers')}</dt>
            <dd className="text-xl font-semibold tabular-nums">{game.servers}</dd>
          </div>
          <div className="rounded-block border border-line px-3 py-2">
            <dt className="text-xs text-muted">{t('games.disableRunning')}</dt>
            <dd className={clsx('text-xl font-semibold tabular-nums', game.running > 0 && 'text-ok')}>{game.running}</dd>
          </div>
        </dl>
        <fieldset className="space-y-2">
          <legend className="label">{t('games.disableQuestion')}</legend>
          {option(false, t('games.disableOnlyNew'), t('games.disableOnlyNewBody'))}
          {option(true, t('games.disableBlock'), game.running > 0 ? t('games.disableBlockBody', { n: game.running }) : t('games.disableBlockBodyNone'), true)}
        </fieldset>
      </div>
    </Modal>
  );
}
