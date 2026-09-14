import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { LinearPanel } from './LinearPanel';

/** Third-party trackers this project can sync with. Linear is the first; a second
 *  integration slots in here as another panel below it. The tab already says
 *  "Integrations", so each panel names itself and nothing repeats the word. */
export function IntegrationsSection({ data }: { data: DispatchProjectData }) {
  return <LinearPanel data={data} />;
}
