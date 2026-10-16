// Railway Infrastructure as Code for the site and the hosted demo, which live in
// the `dispatch` project beside the relay and team services. Replaces the
// `railway.json` config-as-code files (deprecated by Railway after 2026-12-01).
// The site deploys from GitHub on every push to main that touches what it
// reads, once CI passes; the demo is deployed by `railway up` from the repo root
// (its Dockerfile's build context).
// Preview with `railway config plan`, apply with `railway config apply`.
import { defineRailway, github, preserve, project, service } from 'railway/iac';

// The dispatch-relay repo owns the relay and team services in the same project
// as partial `relay`. This partial only creates, changes or deletes what it
// declares, so leaving those out here never touches them.
export const partial = 'site';

// One replica in Railway's default region, restarted on failure; shared by both.
//
// `restartPolicyType`/`restartPolicyMaxRetries` are the desired state but do NOT
// persist as service settings: `railway config apply` reports success, yet
// `config pull` reads them back as null, so `config plan` keeps proposing them
// (checked 2026-09-22, CLI 5.58.0). Every other field here applied cleanly. Until
// that round-trips, apps/demo/railway.json is what puts the policy on a demo
// deployment — do not delete it. The site has no railway.json (a GitHub build
// from the repo root would not read one there), so it runs on Railway's default
// policy, which is also on-failure with 10 retries.
const deploy = {
  restartPolicyType: 'ON_FAILURE',
  restartPolicyMaxRetries: 10,
  runtime: 'V2',
  multiRegionConfig: { 'us-east4-eqdc4a': { numReplicas: 1 } },
  ipv6EgressEnabled: false,
  useLegacyStacker: false,
} as const;

export default defineRailway(() => {
  // dispatch.foo — Astro, built and served by apps/site/Dockerfile (repo-root
  // context) on the PORT Railway injects (8080). checkSuites holds a deploy
  // until the commit's GitHub checks pass, as the old deploy workflow did.
  const site = service('dispatch-site', {
    source: github('wsoule/dispatch', { branch: 'main', checkSuites: true }),
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'apps/site/Dockerfile',
      buildEnvironment: 'V3',
      // Everything the site build reads (apps/site/moon.yml's build inputs),
      // plus the image's own build inputs.
      watchPatterns: [
        'apps/site/**',
        'packages/tokens/**',
        'packages/protocol-spec/versions/**',
        'apps/desktop/src-tauri/tauri.conf.json',
        'pnpm-lock.yaml',
        '.dockerignore',
      ],
    },
    deploy,
    networking: {
      customDomains: { 'dispatch.foo': { port: 8080 } },
      serviceDomains: {
        'dispatch-site-production.up.railway.app': { port: 8080 },
      },
    },
  });

  // The live sandbox the site embeds — apps/demo/src/server.ts serving the
  // desktop bundle, built by the root-context apps/demo/Dockerfile.
  const demo = service('dispatch-demo', {
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'apps/demo/Dockerfile',
      buildEnvironment: 'V3',
    },
    deploy,
    networking: {
      customDomains: { 'demo.dispatch.foo': {} },
      serviceDomains: { 'dispatch-demo-production.up.railway.app': {} },
    },
    // Set in the dashboard; kept as they are rather than restated here.
    env: {
      DEMO_MAX_SESSIONS: preserve(),
      DEMO_SESSION_TTL_MS: preserve(),
      RAILWAY_DOCKERFILE_PATH: preserve(),
    },
  });

  return project('dispatch', { resources: [site, demo] });
});
