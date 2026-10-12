// The model catalogue lives in @dispatch/client; this binds its per-device
// picks to the webview's localStorage so desktop call sites stay unchanged.
import {
  browserStorage,
  type PickableRole,
  readDefaultModel as readDefaultModelIn,
  readRoleModelOverride as readRoleModelOverrideIn,
  resolveExecuteModel as resolveExecuteModelIn,
  resolveRoleModel as resolveRoleModelIn,
  storeRoleModelOverride as storeRoleModelOverrideIn,
} from '@dispatch/client';

export {
  DEFAULT_EFFORT_ID,
  effortFromId,
  effortOptions,
  MODELS,
  modelDisplayName,
  modelLabel,
} from '@dispatch/client';
export type { PickableRole } from '@dispatch/client';

const storage = browserStorage();

export const readDefaultModel = (): string => readDefaultModelIn(storage);

export const resolveExecuteModel = (
  config: Parameters<typeof resolveExecuteModelIn>[0]
): string => resolveExecuteModelIn(config, storage);

export const readRoleModelOverride = (role: PickableRole): string | undefined =>
  readRoleModelOverrideIn(role, storage);

export const storeRoleModelOverride = (role: PickableRole, id: string): void =>
  storeRoleModelOverrideIn(role, id, storage);

export const resolveRoleModel = (
  role: PickableRole,
  config: Parameters<typeof resolveRoleModelIn>[1]
): string => resolveRoleModelIn(role, config, storage);
