import js from '@eslint/js';
import globals from 'globals';
export default [
  { ignores: ['**/node_modules/**', 'outputs/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.worker,
        chrome: 'readonly',
        Cwtch: 'readonly',
        CwtchProtocol: 'readonly',
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
