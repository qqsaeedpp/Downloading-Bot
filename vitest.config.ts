import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, UserWorkspaceConfig } from 'vitest/config';
import { defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * Sources are authored for Node's ESM resolver, so relative imports carry a
 * `.js` extension that does not exist on disk before `tsc` runs. Map those back
 * onto the TypeScript file so the suite runs straight from source with no build
 * step in between.
 */
const resolveTsFromJs: Plugin = {
  name: 'tgtools:resolve-ts-from-js',
  enforce: 'pre',
  resolveId(source, importer) {
    if (importer === undefined || !source.startsWith('.') || !source.endsWith('.js')) return null;
    const candidate = resolve(dirname(importer), `${source.slice(0, -'.js'.length)}.ts`);
    return existsSync(candidate) ? candidate : null;
  },
};

/** Point every workspace package at its TypeScript entry point. */
function workspaceAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const group of ['packages', 'features']) {
    const groupDir = join(rootDir, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(groupDir, entry.name, 'package.json');
      const sourceEntry = join(groupDir, entry.name, 'src', 'index.ts');
      if (!existsSync(manifestPath) || !existsSync(sourceEntry)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string };
      if (manifest.name !== undefined) aliases[manifest.name] = sourceEntry;
    }
  }
  return aliases;
}

const shared = {
  plugins: [resolveTsFromJs],
  resolve: { alias: workspaceAliases() },
} satisfies Partial<UserWorkspaceConfig>;

export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        test: {
          name: 'unit',
          root: rootDir,
          include: ['packages/*/src/**/*.test.ts', 'features/*/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        ...shared,
        test: {
          name: 'integration',
          root: rootDir,
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        ...shared,
        test: {
          name: 'e2e',
          root: rootDir,
          include: ['tests/e2e/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Hits the real internet and real extractors. Never part of `npm test`;
        // run it deliberately with RUN_SMOKE_TESTS=1 when validating a yt-dlp bump.
        ...shared,
        test: {
          name: 'smoke',
          root: rootDir,
          include: ['tests/smoke/**/*.test.ts'],
          environment: 'node',
          testTimeout: 180_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'features/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts'],
    },
  },
});
