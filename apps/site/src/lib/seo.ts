import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DMG, RELEASES } from './downloads';
import { EXTENSIONS, readManifest } from './protocolSource';

export const SITE = 'https://dispatch.foo';
export const REPO = 'https://github.com/wsoule/dispatch';
export const DESCRIPTION =
  'Give AI coding agents tasks, not chats. A shared board for Claude Code, Codex or any MCP agent, on your own machines, with review and a merge queue.';

// The shipping app version, read from the desktop app's Tauri config so
// structured data never names a stale release.
export function appVersion(): string {
  const conf = readFileSync(
    resolve(process.cwd(), '../desktop/src-tauri/tauri.conf.json'),
    'utf8'
  );
  return (JSON.parse(conf) as { version: string }).version;
}

// Every indexable page, for the sitemap and llms.txt. Alias pages
// (/protocol/, /protocol/draft/) are left out: they name an immutable page as
// canonical, and that page is listed instead.
export function indexablePaths(): string[] {
  const manifest = readManifest();
  return [
    '/',
    '/docs',
    '/pricing',
    '/faq',
    '/changelog',
    '/clips',
    '/privacy',
    ...Object.keys(manifest.versions).map((v) => `/protocol/${v}/`),
    ...Object.keys(EXTENSIONS).map((name) => `/a2a/ext/${name}/v1`),
  ];
}

const ORG_ID = `${SITE}/#organization`;

export const organization = {
  '@type': 'Organization',
  '@id': ORG_ID,
  name: 'Dispatch',
  url: SITE,
  logo: `${SITE}/favicon.svg`,
  email: 'hello@dispatch.foo',
  sameAs: [REPO],
};

export const website = {
  '@type': 'WebSite',
  '@id': `${SITE}/#website`,
  name: 'Dispatch',
  url: SITE,
  description: DESCRIPTION,
  inLanguage: 'en',
  publisher: { '@id': ORG_ID },
};

// The app itself, for the home page: what it is, what it runs on, what it
// costs and where to get it.
export function softwareApplication() {
  return {
    '@type': 'SoftwareApplication',
    '@id': `${SITE}/#app`,
    name: 'Dispatch',
    url: SITE,
    description: DESCRIPTION,
    applicationCategory: 'DeveloperApplication',
    applicationSubCategory: 'AI coding agent orchestration',
    operatingSystem: 'macOS, Linux',
    softwareVersion: appVersion(),
    downloadUrl: [DMG.arm, DMG.x64, RELEASES],
    installUrl: `${SITE}/docs`,
    screenshot: `${SITE}/app/tasks.webp`,
    image: `${SITE}/og.png`,
    isAccessibleForFree: true,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      description:
        'Free for up to three people, every feature, commercial use included.',
      url: `${SITE}/pricing`,
    },
    featureList: [
      'Shared task board for AI coding agents',
      'Works with Claude Code, Codex, Gemini CLI and any MCP agent',
      'Each run in its own git worktree',
      'Declared write scope per task',
      'Spend and turn caps per run and per milestone',
      'Review with diff, findings and transcript, then a merge queue',
      'Agent-to-agent messaging and A2A',
      'Agent memory that carries across runs',
      'Milestone map with critical path, exportable as Mermaid',
      'Local first: runs on your machine with your own agent and key',
    ],
    publisher: { '@id': ORG_ID },
  };
}

export function faqPage(faq: [string, string][]) {
  return {
    '@type': 'FAQPage',
    mainEntity: faq.map(([q, a]) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
}

export function breadcrumbs(trail: [string, string][]) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map(([name, path], i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name,
      item: `${SITE}${path}`,
    })),
  };
}

// One JSON-LD graph for a page. `<` is escaped so no string inside can close
// the script element early.
export function ldJson(nodes: object[]): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': nodes,
  }).replace(/</g, '\\u003c');
}
