// ESLint flat config (ESLint 9+). Lints TypeScript sources with typescript-eslint
// and defers all formatting concerns to Prettier via eslint-config-prettier.
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'examples/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Stubs intentionally throw / return placeholders; keep the bar low until
      // stages are implemented.
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  prettier
);
