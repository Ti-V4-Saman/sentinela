import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    fileParallelism: false, // testes compartilham o mesmo banco (sentinela)
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
