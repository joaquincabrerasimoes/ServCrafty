import { Info } from 'lucide-react';
import { useT } from '@/i18n';
import { Toggle } from '@/components/ui';

/** Per-server "show on the local network" switch (Minecraft Java only), with its explanation. */
export function LanAnnounceField({
  checked,
  onChange,
  disabled,
  bedrock,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  bedrock?: boolean;
}) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <Toggle checked={bedrock ? false : checked} onChange={onChange} disabled={disabled || bedrock} label={t('lan.label')} />
      <p className="flex gap-2 text-xs text-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{bedrock ? t('lan.bedrock') : t('lan.hint')}</span>
      </p>
    </div>
  );
}
