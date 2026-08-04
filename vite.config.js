import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Идентификатор сборки: вшивается в бандл (__BUILD_ID__) и одновременно кладётся
// в dist/version.json. Фронт периодически сверяет version.json с вшитым id —
// расхождение = вышла новая версия, показываем попап с предложением обновить.
const buildId = Date.now().toString()

// Плагин пишет dist/version.json при production-сборке (в dev-сервере hook
// generateBundle не вызывается — файла нет, попап не срабатывает).
const emitVersion = {
  name: 'emit-version',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: JSON.stringify({ buildId }),
    })
  },
}

export default defineConfig({
  plugins: [react(), emitVersion],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Выносим тяжёлые библиотеки в отдельные чанки
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-supabase': ['@supabase/supabase-js'],
          'vendor-xlsx': ['xlsx'],
        }
      }
    }
  }
})
