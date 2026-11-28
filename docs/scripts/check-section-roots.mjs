// Fails the docs build when a section has pages but nothing at its root.
//
// A reader who trims a URL (`/extensions/facets/` → `/extensions/`) or follows a link to a
// section expects to land somewhere. Starlight builds no section index on its own, so each
// section root needs either its own `index.mdx` or an entry in `redirects` in
// `astro.config.mjs`. This walks the built site in `dist/` and reports every top-level
// directory that holds pages but has no `index.html` of its own.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));

// Build output that is not a docs section.
const notSections = new Set(['_astro', 'pagefind']);

const missing = [];
for (const name of readdirSync(dist)) {
  const dir = join(dist, name);
  if (notSections.has(name) || !statSync(dir).isDirectory()) continue;
  const hasPages = readdirSync(dir).some((child) =>
    existsSync(join(dir, child, 'index.html')),
  );
  if (hasPages && !existsSync(join(dir, 'index.html'))) missing.push(`/${name}/`);
}

if (missing.length > 0) {
  console.error(
    `These sections have pages but nothing at their root, so the root URL 404s:\n` +
      missing.map((path) => `  ${path}`).join('\n') +
      `\nAdd an index.mdx for the section, or a redirect to its first page in astro.config.mjs.`,
  );
  process.exit(1);
}
console.log('Every section root resolves.');
