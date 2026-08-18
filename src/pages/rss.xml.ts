import type { APIRoute } from 'astro';
import home from '../data/home.json';
import { flattenTopicNodes, getTopicForest } from '../utils/topics';

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export const GET: APIRoute = async () => {
  const siteUrl = (home.siteUrl || 'https://lulietlyan.github.io').replace(/\/$/, '');
  const nodes = flattenTopicNodes(await getTopicForest());

  const items = nodes
    .filter((node) => node.entry)
    .map((node) => {
      const date = node.date ?? new Date();
      return `    <item>
      <title>${escapeXml(node.title)}</title>
      <link>${siteUrl}${node.href}</link>
      <guid>${siteUrl}${node.href}</guid>
      <pubDate>${date.toUTCString()}</pubDate>
      <description>${escapeXml(node.description || node.title)}</description>
    </item>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(home.name)}</title>
    <link>${siteUrl}</link>
    <description>${escapeXml(home.description)}</description>
    <language>${home.lang || 'zh-CN'}</language>
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
    },
  });
};
