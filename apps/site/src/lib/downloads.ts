// release.yml uploads version-free DMG copies, so these always reach the newest build.
export const RELEASES = 'https://github.com/wsoule/dispatch/releases/latest';

export const DMG = {
  arm: `${RELEASES}/download/Dispatch_aarch64.dmg`,
  x64: `${RELEASES}/download/Dispatch_x64.dmg`,
} as const;
