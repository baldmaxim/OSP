// Результат перехода по ссылке из письма Supabase Auth (подтверждение почты).
//
// Supabase возвращает на сайт с параметрами в адресе:
//   успех  — #access_token=…&type=signup;
//   ошибка — #error=access_denied&error_code=otp_expired&error_description=…
// supabase-js забирает их при создании клиента и стирает из адреса ещё до того,
// как откроется страница входа. Поэтому модуль импортируется ПЕРВЫМ в main.jsx
// и запоминает параметры сразу при загрузке приложения.

function readParams() {
  if (typeof window === 'undefined') return null
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const search = new URLSearchParams(window.location.search)
  const get = (key) => hash.get(key) || search.get(key) || null
  const errorCode = get('error_code')
  const error = get('error')
  if (errorCode || error) {
    return {
      kind: 'error',
      code: errorCode || error,
      description: get('error_description'),
    }
  }
  const type = get('type')
  if (hash.get('access_token') && (type === 'signup' || type === 'email')) {
    return { kind: 'confirmed' }
  }
  return null
}

let pending = readParams()

// Забрать результат один раз: повторный показ сообщения после навигации не нужен.
export function takeAuthRedirectResult() {
  const result = pending
  pending = null
  if (result && typeof window !== 'undefined' && (window.location.hash || window.location.search)) {
    // Убираем служебные параметры из адреса, чтобы их не сохранили в закладки.
    const url = new URL(window.location.href)
    url.hash = ''
    for (const key of ['error', 'error_code', 'error_description']) url.searchParams.delete(key)
    window.history.replaceState(window.history.state, '', url.pathname + url.search)
  }
  return result
}
