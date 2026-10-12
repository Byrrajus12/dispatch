// Gate adapters live in @dispatch/client so every client reads gates the same way.
export {
  approvalReply,
  findOverseerActionGate,
  findOverseerApprovalGate,
  findToolApprovalGate,
  foldsIntoOpenApproval,
  gateNotification,
  gateOf,
  isSystemMarker,
  openGatesAfter,
  openGatesKey,
  questionsByRun,
  runIdOf,
  runsAskingMe,
  scopeRequestsByRun,
  taskProposalOf,
  toolApprovalOf,
} from '@dispatch/client';
export type { RunQuestion, RunScopeRequest } from '@dispatch/client';
