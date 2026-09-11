// Подмена RoleContext для UI-стенда: права раздела «contracts» задаются
// параметром адреса; окончательную проверку всё равно делает база.
const params = new URLSearchParams(window.location.search)
const edit = params.get('edit') !== '0'

// Как в настоящем RoleContext, ссылки стабильны между рендерами (scopedObjectIds
// там мемоизирован) — иначе эффекты с этими зависимостями перезапускались бы.
const ROLE = {
  canEdit: (section) => section === 'contracts' && edit,
  canView: () => true,
  scopedObjectIds: [],
  isEmployee: true,
  isAdmin: false,
  userProfile: { full_name: 'Тест' },
}

export function useRole() {
  return ROLE
}

export function RoleProvider({ children }) {
  return children
}
