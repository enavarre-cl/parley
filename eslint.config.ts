// ESLint (flat config, loaded as TypeScript via jiti). Pragmatic: catches real bugs (unawaited
// promises, unused vars) without being pedantic about `any` (the code handles dynamic JSON on purpose).
import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/host/**/*.ts', 'src/shared/**/*.ts'],
    ignores: ['src/host/test/**'],
    languageOptions: {
      parser,
      parserOptions: { project: './tsconfig.json' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['warn', { checksVoidReturn: false }],
      '@typescript-eslint/await-thenable': 'warn',
    },
  },
];
