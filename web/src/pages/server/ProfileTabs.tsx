import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { isCs16, isL4d2 } from '@/lib/gameDefs';
import { Loading } from '@/components/ui';
import { useServerCtx } from './ServerLayout';

/**
 * The Maps, Controls and Plugins tabs share their paths between the game integrations (`profile` of the
 * game definition): each tab renders the page of the server's game. Until the definition has loaded
 * nothing is fetched (ServerLayout sends other games back to the overview).
 */
const L4d2Maps = lazy(() => import('./L4d2Maps'));
const L4d2Controls = lazy(() => import('./L4d2Controls'));
const L4d2Plugins = lazy(() => import('./L4d2Plugins'));
const Cs16Maps = lazy(() => import('./Cs16Maps'));
const Cs16Controls = lazy(() => import('./Cs16Controls'));
const Cs16Plugins = lazy(() => import('./Cs16Plugins'));

type Page = LazyExoticComponent<ComponentType>;

function ByProfile({ l4d2: L4d2, cs16: Cs16 }: { l4d2: Page; cs16: Page }) {
  const { def } = useServerCtx();
  if (isCs16(def)) return <Cs16 />;
  if (isL4d2(def)) return <L4d2 />;
  return <Loading />;
}

export const MapsTab = () => <ByProfile l4d2={L4d2Maps} cs16={Cs16Maps} />;
export const ControlsTab = () => <ByProfile l4d2={L4d2Controls} cs16={Cs16Controls} />;
export const PluginsTab = () => <ByProfile l4d2={L4d2Plugins} cs16={Cs16Plugins} />;
