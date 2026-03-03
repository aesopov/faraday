import eslint from '@eslint/js';
import { globalIgnores, defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(globalIgnores(['out', '.vite']), eslint.configs.recommended, tseslint.configs.recommended, {
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
  },
});
