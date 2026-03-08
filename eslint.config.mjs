import eslintReact from '@eslint-react/eslint-plugin';
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(globalIgnores(['out', '.vite']),
  eslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,jsx,mjsx,ts,mts,tsx,mtsx}'],
    ...eslintReact.configs["recommended-typescript"],
  },
  tseslint.configs.recommended, {
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@eslint-react/hooks-extra/no-direct-set-state-in-use-effect': 'off',
  },
});
