/** @type {import("prettier").Config} */
export default {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  arrowParens: 'always',
  endOfLine: 'lf',
  overrides: [
    {
      // YAML reads better with double quotes. Markdown is excluded on purpose:
      // the override reaches inside fenced code blocks, and rewriting the
      // quotes in a documented TypeScript excerpt makes it stop matching the
      // source it is quoting.
      files: ['*.yml', '*.yaml'],
      options: { singleQuote: false },
    },
  ],
};
