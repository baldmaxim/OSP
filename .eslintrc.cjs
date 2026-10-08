module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  settings: { react: { version: '18.3' } },
  plugins: ['react-refresh'],
  rules: {
    'react/jsx-no-target-blank': 'off',
    // Проект на чистом JS без PropTypes/TypeScript — правило только шумит.
    'react/prop-types': 'off',
    // HMR-only хинт; контексты в проекте намеренно держат провайдер + хук + константы в одном файле.
    'react-refresh/only-export-components': 'off',
  },
  overrides: [
    {
      // Доступ к серверу — только через адаптеры src/api/ (Р3, migration/PLAN.md).
      files: ['src/**/*.{js,jsx}'],
      excludedFiles: ['src/api/**'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [
            { group: ['@supabase/*'], message: 'Клиент Supabase — только в src/api/. Используйте db, auth, objectPhotos, invokeFunction, subscribeTable из src/api.' },
            { group: ['**/api/supabaseClient', '**/api/supabaseClient.js'], message: 'Клиент напрямую не импортируется — используйте адаптеры из src/api.' },
          ],
        }],
      },
    },
  ],
}
