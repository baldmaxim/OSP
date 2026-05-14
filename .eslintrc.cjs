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
}
