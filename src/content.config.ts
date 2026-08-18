import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

function toTopicId(entry: string): string {
  const normalized = entry.replaceAll('\\', '/');
  const withoutExt = normalized.replace(/\.(md|mdx)$/i, '');
  const parts = withoutExt.split('/').filter(Boolean);
  const last = parts.at(-1) ?? '';

  if (/^(readme|index)$/i.test(last)) {
    parts.pop();
  }

  return parts.join('/');
}

const topics = defineCollection({
  loader: glob({
    pattern: ['**/*.md', '**/*.mdx'],
    base: './topics',
    generateId: ({ entry }) => {
      const id = toTopicId(entry);
      if (!id) {
        throw new Error(`Topic files must live in a subdirectory of topics/: ${entry}`);
      }
      return id;
    },
  }),
  schema: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    date: z.coerce.date().optional(),
    updated: z.coerce.date().optional(),
    draft: z.boolean().optional().default(false),
    order: z.number().optional(),
    icon: z.string().optional(),
    tags: z.array(z.string()).optional().default([]),
  }),
});

export const collections = { topics };
