import eslint from '@eslint/js';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Packages that pull in a framework, a driver or a transport. Anything importing
 * one of these is, by definition, infrastructure — so the domain and application
 * layers must never reach for them. Enforced instead of merely documented,
 * because a boundary nobody checks is a boundary that erodes on the first
 * "just this once".
 */
const FRAMEWORK_PACKAGES = [
  'grammy',
  'grammy/*',
  '@grammyjs/*',
  'bullmq',
  'ioredis',
  'drizzle-orm',
  'drizzle-orm/*',
  'postgres',
  'pino',
  'ytdlp-nodejs',
  '@tgtools/database',
  '@tgtools/queue',
  '@tgtools/telegram',
  '@tgtools/downloader-engine',
];

/** Layers that a lower layer may not reach into, expressed as relative paths. */
const OUTWARD_LAYER_PATHS = [
  '**/infrastructure',
  '**/infrastructure/**',
  '**/presentation',
  '**/presentation/**',
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.turbo/**',
      'infra/migrations/**',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: ['*/*/tsconfig.json'],
          // One tsconfig per workspace package is the point of this layout; the
          // resolver's advice to consolidate is aimed at single-project repos.
          noWarnOnMultipleProjects: true,
        },
      },
    },
    rules: {
      'import-x/no-cycle': ['error', { maxDepth: 8, ignoreExternal: true }],
      'import-x/no-self-import': 'error',

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      // A `default` branch counts as covering the rest of a union. Where we want
      // true exhaustiveness — the Persian message table, the stage labels — the
      // default calls `assertNever`, which fails to compile if a member is
      // added. That is a stronger guarantee than this rule can give, and it
      // does not force every incidental switch to enumerate nine error kinds.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false, allowNullish: false },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // An empty catch silently turns a failure into a success. Where ignoring is
      // genuinely right, the block must say so in a comment.
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-console': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Read configuration through @tgtools/config instead.' },
      ],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-param-reassign': 'error',
    },
  },

  // ── Layer boundaries ──────────────────────────────────────────────────────
  {
    files: ['features/*/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: FRAMEWORK_PACKAGES,
              message: 'domain/ must stay framework-free. Define a port and adapt it outside.',
            },
            {
              group: ['**/application', '**/application/**', ...OUTWARD_LAYER_PATHS],
              message: 'domain/ may not depend on outer layers.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['features/*/src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: FRAMEWORK_PACKAGES,
              message: 'application/ talks to ports only, never to a driver.',
            },
            {
              group: OUTWARD_LAYER_PATHS,
              message: 'application/ may not depend on infrastructure or presentation.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/downloader-engine/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'grammy',
                'grammy/*',
                '@grammyjs/*',
                'bullmq',
                'drizzle-orm',
                'drizzle-orm/*',
                '@tgtools/database',
                '@tgtools/queue',
                '@tgtools/telegram',
              ],
              message:
                'The engine knows nothing about Telegram, queues or the database. Keep it that way.',
            },
          ],
        },
      ],
    },
  },

  // ── Relaxations ───────────────────────────────────────────────────────────
  {
    // The places that legitimately touch `process`: the config loader reads the
    // environment, the shutdown handler installs signal listeners and calls
    // `exit`, each app's entry point reports a startup failure to stderr before
    // a logger exists, and the child-process runner needs `process.platform`
    // and `process.kill` — OS primitives with no config-shaped alternative, and
    // not what this rule is aimed at.
    files: [
      'packages/config/src/**/*.ts',
      'packages/file-tools-engine/src/process/child-process-runner.ts',
      'packages/shared/src/lifecycle/**/*.ts',
      'apps/*/src/bootstrap.ts',
      'apps/*/src/migrate.ts',
      'infra/scripts/**/*.ts',
    ],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    // Tests sit next to the sources they cover but are excluded from each
    // package's tsconfig, so the type-aware parser has no program for them.
    // Turning type checking off here is the honest fix: the alternative is a
    // second tsconfig per package that exists only to satisfy the linter.
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-imports': 'off',
      'no-console': 'off',
    },
  },
  {
    // Config files sit outside every package's `include`, so the type-aware
    // parser has no program for them.
    files: ['**/*.js', '**/*.mjs', '**/*.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      'no-restricted-globals': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
);
