import type { APIRoute } from 'astro';
import home from '../data/home.json';
import writing from '../data/writing.json';
import notes from '../data/projects.json';
import topics from '../data/tech.json';

export const GET: APIRoute = async () => {
  const siteUrl = (home.siteUrl || 'https://your-domain.com').replace(/\/$/, '');

  const topicsStr = topics.categories
    .map((category) => `- **${category.title}:** ${category.skills.map((item) => item.name).join(', ')}`)
    .join('\n');

  const writingStr = writing
    .map((item) => `- **${item.role}** - ${item.company} (${item.period})\n  * ${item.description}`)
    .join('\n');

  const notesStr = notes
    .map((item) => `- **${item.title}:** ${item.description}${item.link ? ` (${item.link})` : ''}`)
    .join('\n');

  const socialsStr = home.socials
    .filter((item) => item.url && item.url !== '#' && item.url !== '')
    .map((item) => `- **${item.name}:** ${item.url}`)
    .join('\n');

  const markdown = `# ${home.name}

> ${home.description}

## Overview
${home.name} publishes ${home.jobTitle || 'personal essays and notes'}${home.location ? ` from ${home.location}` : ''}. ${home.description}

## Key Information
${home.location ? `- **Location:** ${home.location}` : ''}
${home.availability ? `- **Status:** ${home.availability}` : ''}
- **Website:** ${siteUrl}

## Topics
${topicsStr}

## Latest Writing
${writingStr}

## Featured Notes
${notesStr}

## Contact & Links
- **Website:** ${siteUrl}
${socialsStr}
`;

  return new Response(markdown.trim() + '\n', {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
};
