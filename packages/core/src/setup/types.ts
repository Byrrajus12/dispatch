export type SetupStatus = 'ok' | 'missing' | 'needs-action' | 'unknown';
export type AuthState = 'signed-in' | 'signed-out' | 'unknown';

/** One way to install an agent, tried in the catalog's order. */
export type InstallMethod =
  | { kind: 'script'; url: string }
  | { kind: 'brew'; formula: string; cask?: boolean }
  | { kind: 'npm'; pkg: string }
  | { kind: 'url'; href: string };

export interface ProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process never started or timed out. */
  error?: string;
}

export interface ProviderSpec {
  id: string;
  name: string;
  /** One plain-English line, e.g. "Uses your Claude Pro or Max plan". */
  blurb: string;
  binary: string;
  install: readonly InstallMethod[];
  /** Interactive login argv, run in the built-in terminal. */
  signIn?: readonly string[];
  /** Non-interactive sign-in probe; absent means sign-in can't be checked. */
  authCheck?: { args: readonly string[]; parse: (r: ProbeResult) => AuthState };
  /** Env var an API key for this provider goes in. */
  apiKeyEnv?: string;
  capabilities: { execute: boolean; plan: boolean; oversee: boolean };
}

/** A button the UI can show. `run` goes to the built-in terminal. */
export type SetupFix =
  | { kind: 'run'; label: string; command: string[] }
  | { kind: 'open-url'; label: string; href: string }
  | { kind: 'install-git'; label: string }
  | { kind: 'git-identity'; label: string }
  | { kind: 'prepare-folder'; label: string };

export interface ProviderState {
  id: string;
  name: string;
  blurb: string;
  installed: boolean;
  /** Installed and `<binary> --version` exits 0. */
  works: boolean;
  auth: AuthState;
  usingApiKey: boolean;
  /** Installed, starts, and not known to be signed out (or has a key). */
  ready: boolean;
  capabilities: ProviderSpec['capabilities'];
  apiKeyEnv?: string;
  /** Install (or reinstall) fix when not installed or broken. */
  install?: SetupFix;
  signIn?: SetupFix;
  /** First line of a failed probe, for the Details disclosure. */
  detail?: string;
}

export type SetupStepId = 'git' | 'project' | 'agent';

export interface SetupStep {
  id: SetupStepId;
  status: SetupStatus;
  message: string;
  fix?: SetupFix;
  detail?: string;
}

export interface SetupReport {
  steps: SetupStep[];
  providers: ProviderState[];
  /** Catalog id of the provider dispatches run on, or null if none is known. */
  defaultProvider: string | null;
}
