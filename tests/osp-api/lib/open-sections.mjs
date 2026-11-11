// Права разделов шлюза (server/osp-api/src/lib/sectionRights.js) для наборов, которые проверяют не их, а вход, CSRF,
// барьеры и передачу запроса: каждый вошедший — как администратор по разделам, карта пустая. Список allow.json,
// список учётки с регистрации, правила базы и функций действуют как обычно. Права разделов — tests/osp-api/db-sections.test.mjs.
const ADMIN_RIGHTS = Object.freeze({ role: 'admin', roleLabel: null, admin: true, superadmin: false, employee: true, contractor: false, can: () => true })
export const openSections = Object.freeze({
  sectionRights: { get: async () => ADMIN_RIGHTS },
  sectionMap: { tables: {}, rpc: {} },
})
