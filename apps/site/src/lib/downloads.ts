// The one place the site names the app's version and where to get it.
// Releases on wsoule/dispatch also hold the old app, so `latest` cannot be
// trusted to point at this one: the DMG link names its tag outright.
export const VERSION = '1.0.0';

export const RELEASES = 'https://github.com/wsoule/dispatch/releases';

export const DMG = `${RELEASES}/download/app-v${VERSION}/Dispatch_${VERSION}_universal.dmg`;

// The macOS install line. public/install.sh is added separately.
export const INSTALL = 'curl -fsSL https://dispatch.foo/install.sh | sh';

export const TEAM_SERVER = 'https://team.dispatch.foo';
