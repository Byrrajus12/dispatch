// Tauri rejects with plain strings, the daemon client with Errors.
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Unknown error';
}
