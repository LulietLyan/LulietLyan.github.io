import { getCollection, type CollectionEntry } from 'astro:content';

export type TopicEntry = CollectionEntry<'topics'>;

export type TopicNode = {
  id: string;
  title: string;
  description: string;
  href: string;
  order: number;
  icon?: string;
  tags: string[];
  date?: Date;
  draft: boolean;
  isColumn: boolean;
  entry?: TopicEntry;
  children: TopicNode[];
};

export const TOPICS_BASE = '/topics';

export function isIndexFile(filePath?: string): boolean {
  if (!filePath) return false;
  const name = filePath.replaceAll('\\', '/').split('/').pop() ?? '';
  return /^(readme|index)\.(md|mdx)$/i.test(name);
}

export function titleFromId(id: string): string {
  const last = id.split('/').pop() ?? id;
  return last
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export async function getVisibleTopics(): Promise<TopicEntry[]> {
  return getCollection('topics', ({ data }) => {
    if (import.meta.env.DEV) return true;
    return !data.draft;
  });
}

function parentId(id: string): string | null {
  const index = id.lastIndexOf('/');
  return index === -1 ? null : id.slice(0, index);
}

export function buildTopicForest(entries: TopicEntry[]): TopicNode[] {
  const byId = new Map<string, TopicNode>();

  const ensure = (id: string): TopicNode => {
    let node = byId.get(id);
    if (!node) {
      node = {
        id,
        title: titleFromId(id),
        description: '',
        href: `${TOPICS_BASE}/${id}`,
        order: Number.MAX_SAFE_INTEGER,
        tags: [],
        draft: false,
        isColumn: true,
        children: [],
      };
      byId.set(id, node);
    }
    return node;
  };

  for (const entry of entries) {
    const node = ensure(entry.id);
    node.entry = entry;
    node.title = entry.data.title ?? titleFromId(entry.id);
    node.description = entry.data.description ?? '';
    node.order = entry.data.order ?? Number.MAX_SAFE_INTEGER;
    node.icon = entry.data.icon;
    node.tags = entry.data.tags ?? [];
    node.date = entry.data.date ?? entry.data.updated;
    node.draft = entry.data.draft ?? false;
    node.isColumn = isIndexFile(entry.filePath);
  }

  for (const id of [...byId.keys()]) {
    let current = parentId(id);
    while (current) {
      ensure(current);
      current = parentId(current);
    }
  }

  const roots: TopicNode[] = [];
  for (const node of byId.values()) {
    const parent = parentId(node.id);
    if (parent) {
      ensure(parent).children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortNodes = (nodes: TopicNode[]) => {
    nodes.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      const dateA = a.date?.getTime() ?? 0;
      const dateB = b.date?.getTime() ?? 0;
      if (dateA !== dateB) return dateB - dateA;
      return a.title.localeCompare(b.title);
    });
    nodes.forEach((child) => sortNodes(child.children));
  };

  sortNodes(roots);
  return roots;
}

export function findTopicNode(forest: TopicNode[], id: string): TopicNode | undefined {
  const parts = id.split('/').filter(Boolean);
  let nodes = forest;
  let found: TopicNode | undefined;
  let acc = '';

  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    found = nodes.find((node) => node.id === acc);
    if (!found) return undefined;
    nodes = found.children;
  }

  return found;
}

export function flattenTopicNodes(nodes: TopicNode[]): TopicNode[] {
  return nodes.flatMap((node) => [node, ...flattenTopicNodes(node.children)]);
}

export function breadcrumbsFor(
  id: string,
  forest: TopicNode[],
): { label: string; href: string }[] {
  const crumbs = [{ label: 'Topics', href: TOPICS_BASE }];
  const parts = id.split('/').filter(Boolean);
  let acc = '';

  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    const node = findTopicNode(forest, acc);
    crumbs.push({
      label: node?.title ?? titleFromId(acc),
      href: `${TOPICS_BASE}/${acc}`,
    });
  }

  return crumbs;
}

export function splitChildren(node: TopicNode): {
  columns: TopicNode[];
  articles: TopicNode[];
} {
  const columns: TopicNode[] = [];
  const articles: TopicNode[] = [];

  for (const child of node.children) {
    if (child.isColumn || child.children.length > 0) {
      columns.push(child);
    } else {
      articles.push(child);
    }
  }

  return { columns, articles };
}

export async function getTopicForest(): Promise<TopicNode[]> {
  const entries = await getVisibleTopics();
  return buildTopicForest(entries);
}
