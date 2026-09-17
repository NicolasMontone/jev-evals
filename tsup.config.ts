import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  target: 'es2022',
  dts: {
    entry: {
      index: 'src/index.ts',
    },
  },
  splitting: false,
  sourcemap: true,
  clean: true,
  shims: false,
});
