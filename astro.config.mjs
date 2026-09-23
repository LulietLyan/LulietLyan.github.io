// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import icon from 'astro-icon';
import sitemap from '@astrojs/sitemap';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

import homeData from './src/data/home.json';

/** @returns {(tree: any, file: any) => void} */
function promoteDoubleDollarMath() {
  return (tree, file) => {
    const source = String(file);

    /** @param {any} node */
    const visit = (node) => {
      if (node.type === 'inlineMath' && node.position) {
        const raw = source.slice(node.position.start.offset, node.position.end.offset);
        if (raw.startsWith('$$') && raw.endsWith('$$')) {
          node.type = 'math';
          node.data = {
            hName: 'code',
            hProperties: { className: ['language-math', 'math-display'] },
            hChildren: [{ type: 'text', value: node.value }],
          };
        }
      }

      node.children?.forEach(visit);
    };

    visit(tree);
  };
}


const siteUrl = process.env.SITE_URL || homeData.siteUrl || undefined;

// https://astro.build/config
export default defineConfig({
  site: siteUrl,
  vite: {
    plugins: [tailwindcss()]
  },

  markdown: {
    remarkPlugins: [remarkMath, promoteDoubleDollarMath],
    rehypePlugins: [rehypeKatex],
  },

  integrations: [icon(), sitemap()]
});
