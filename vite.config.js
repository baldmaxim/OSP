import fs from 'node:fs'
import process from 'node:process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Идентификатор сборки: вшивается в бандл (__BUILD_ID__) и одновременно кладётся
// в dist/version.json. Фронт периодически сверяет version.json с вшитым id —
// расхождение = вышла новая версия, показываем попап с предложением обновить.
// OSP_BUILD_ID — только для тестов, которым нужны две сборки с известными id.
const buildId = process.env.OSP_BUILD_ID || Date.now().toString()

// Уровень совместимости (release.json). Поднимается вручную, когда релиз
// несовместим со старыми вкладками (сервер убрал то, чем они пользуются): у вкладки
// с меньшим уровнем окно обновления появляется без кнопки «Позже». rollbackFloor —
// ниже какого уровня откат фронта уже небезопасен (deploy/rollback.sh не пустит).
const release = JSON.parse(fs.readFileSync(new URL('./release.json', import.meta.url), 'utf8'))
const compat = Number(release.compat) || 0
const rollbackFloor = Number(release.rollbackFloor) || 0

// Плагин пишет dist/version.json при production-сборке (в dev-сервере hook
// generateBundle не вызывается — файла нет, попап не срабатывает).
const emitVersion = {
  name: 'emit-version',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: JSON.stringify({ buildId, compat, rollbackFloor }),
    })
  },
}

export default defineConfig({
  plugins: [react(), emitVersion],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    __BUILD_COMPAT__: JSON.stringify(compat),
  },
  server: {
    // Явный IPv4. Без этого Vite слушает хост 'localhost', а начиная с Node 17
    // адреса не переупорядочиваются — на Windows 'localhost' разрешается сначала
    // в IPv6 (::1), и сервер поднимается только на нём. Встроенный браузер
    // VS Code и часть клиентов идут на 127.0.0.1 и получают ERR_CONNECTION_REFUSED
    // при живом сервере.
    //
    // Именно 127.0.0.1, а не host: true: последнее слушает все интерфейсы и
    // открывает локальный стенд всей сети. Показать вёрстку с телефона можно
    // разовым `npm run dev -- --host`, конфиг для этого менять не нужно.
    host: '127.0.0.1',
    port: 5173,
    // Занятый порт должен приводить к явной ошибке, а не к молчаливому переезду
    // на 5174 — иначе ссылка из терминала не совпадает с тем, что открываешь.
    strictPort: true,
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
