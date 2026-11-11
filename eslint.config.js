import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      'node_modules/',
      'coverage/',
      'data/',
      '.claude/',
      '.graphify/',
      '.impeccable/',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // The browser UI is JavaScript type-checked by its own tsconfig, so it
    // gets the same type-aware rules as the TypeScript.
    files: ['public/**/*.js'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.public.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // tsc already rejects undefined names, and knows the browser globals.
    rules: { 'no-undef': 'off' },
  },
);
