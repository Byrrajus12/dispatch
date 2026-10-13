import type { APIRoute } from 'astro';

import { indexablePaths, SITE } from '../lib/seo';

// Every indexable page. No lastmod: a build date on every URL would claim
// changes that did not happen, and crawlers learn to ignore it.
export const GET: APIRoute = () =>
  new Response(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...indexablePaths().map(
        (path) => `  <url><loc>${SITE}${path}</loc></url>`
      ),
      '</urlset>',
      '',
    ].join('\n'),
    { headers: { 'content-type': 'application/xml; charset=utf-8' } }
  );
