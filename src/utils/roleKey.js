// Служебный ключ новой роли — из её названия: администратор вводит только название, запоминать и придумывать ключ незачем
// (03.11, решение пользователя: вместо вкладки «Роли» — добавление рядом с выбором роли). Ключ — латиница, цифры и «_», с
// буквы: так его проверяла прежняя форма, и так он записан в user_roles.role и role_permissions.role. Раз выданный ключ
// не меняется: переименование правит только название.

const LETTERS = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '',
  ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}
const MAX_LENGTH = 40

export function roleKeyFromLabel(label, takenKeys = []) {
  const latin = [...String(label ?? '').toLowerCase()].map((ch) => LETTERS[ch] ?? ch).join('')
  const slug = latin.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, MAX_LENGTH).replace(/_+$/, '')
  // Название из одних цифр или знаков: ключ всё равно должен начинаться с буквы.
  const base = /^[a-z]/.test(slug) ? slug : `role${slug ? `_${slug}` : ''}`
  const taken = new Set(takenKeys)
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const key = `${base}_${n}`
    if (!taken.has(key)) return key
  }
}

// Такая роль уже есть: имена сравниваются без регистра и лишних пробелов.
export function sameRoleLabel(a, b) {
  const norm = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  return norm(a) === norm(b)
}
