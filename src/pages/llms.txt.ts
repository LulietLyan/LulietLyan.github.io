import type { APIRoute } from 'astro';
import home from '../data/home.json';
import { getTopicForest } from '../utils/topics';

function renderTree(nodes: Awaited<ReturnType<typeof getTopicForest>>, depth = 0): string {
  return nodes
    .map((node) => {
      const indent = '  '.repeat(depth);
      const line = `${indent}- [${node.title}](${node.href})${node.description ? `: ${node.description}` : ''}`;
      const children = node.children.length ? `\n${renderTree(node.children, depth + 1)}` : '';
      return `${line}${children}`;
    })
    .join('\n');
}

export const GET: APIRoute = async () => {
  const siteUrl = (home.siteUrl || 'https://lulietlyan.github.io').replace(/\/$/, '');
  const forest = await getTopicForest();
  const socials = home.socials
    .filter((item) => item.url && item.url !== '#' && item.url !== '')
    .map((item) => `- **${item.name}:** ${item.url}`)
    .join('\n');

  const markdown = `# ${home.name}

> ${home.description}

## Overview
${home.name} writes notes on Computer Network, Operating System, MySQL, Redis, Message Queue, Golang, and Projects.

## Key Information
${home.availability ? `- **Status:** ${home.availability}` : ''}
- **Website:** ${siteUrl}
- **Author:** ${home.name} / LulietLyan

## Topics
${renderTree(forest)}

## Contact & Links
- **Website:** ${siteUrl}
${socials}
`;

  return new Response(markdown.trim() + '\n', {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
};
