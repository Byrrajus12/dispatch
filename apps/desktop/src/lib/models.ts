// The model catalogue lives in @dispatch/client; this binds its per-device
// picks to the webview's localStorage so desktop call sites stay unchanged.
import {
  browserStorage,
  readDefaultModel as readDefaultModelIn,
  resolveExecuteModel as resolveExecuteModelIn,
} from '@dispatch/client';

export {
  DEFAULT_EFFORT_ID,
  effortFromId,
  effortOptions,
  MODELS,
  modelDisplayName,
  modelLabel,
} from '@dispatch/client';

const storage = browserStorage();

export const readDefaultModel = (): string => readDefaultModelIn(storage);

export const resolveExecuteModel = (
  config: Parameters<typeof resolveExecuteModelIn>[0]
): string => resolveExecuteModelIn(config, storage);
