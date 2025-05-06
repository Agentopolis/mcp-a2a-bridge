import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Optional: Add setup file if needed
    // setupFiles: './src/test/setup.ts',
    coverage: {
      provider: 'v8', // or 'istanbul'
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        'src/types.ts', // Exclude type definition files if any
        'src/test/**',
      ],
      // Optional: Enforce coverage thresholds
      // lines: 80,
      // functions: 80,
      // branches: 80,
      // statements: 80,
    },
  },
}); 