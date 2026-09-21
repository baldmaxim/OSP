// Копирование текста в буфер обмена с fallback'ом для незащищённых контекстов (http://),
// где navigator.clipboard недоступен. Возвращает true при успехе.
export async function copyToClipboard(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // упадём в fallback ниже
    }
  }
  // Fallback через скрытый <textarea> и document.execCommand('copy').
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '0'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
