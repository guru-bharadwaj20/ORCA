import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The source uses NodeNext-style `.js` import specifiers that actually resolve to
  // `.ts` files. Teach Vite/Vitest to try `.ts` first so tests can import the sources.
  resolve: {
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/types.ts', 'src/types/**'],
    },
  },
});
