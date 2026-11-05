// Регистрация подрядчика: до входа сессии нет — обычный fetch; заявки у администратора — с сессией (sessionFetch).
import { sessionFetch } from './sessionClient'
import { getAuthMode } from './authMode'
import { createSignupClient, createSignupAdminClient } from './contractorSignupClient'

export const contractorSignup = createSignupClient({ fetchImpl: (url, init) => fetch(url, init) })
export const contractorSignupsAdmin = createSignupAdminClient({ fetchImpl: sessionFetch })

// Открыта ли регистрация — решил сервер (/api/auth/config): страница только не предлагает закрытое.
export const signupOpen = () => getAuthMode().signup === true
// Заявку решает администратор: писем нет, ни ссылок подтверждения, ни восстановления пароля по почте.
export const signupManual = () => getAuthMode().signupMode === 'manual'
