// Вкладка «Администрирование» → «Signal» отдельно (signal-stand.html?page=tab): в обвязке страницы «Администрирование» —
// её стили кнопок и вкладок; сообщения вкладки (notify) — всплывающей строкой, как на странице. «Сервер» — signal-admin-fake.js.
import '../../../src/pages/AdminPage.css'
import { useState } from 'react'
import SignalTab from '../../../src/components/admin/SignalTab'

export default function SignalAdminStand() {
  const [toast, setToast] = useState(null)
  const notify = (kind, text) => setToast({ kind, text })
  return (
    <div className="admin-page" style={{ padding: '1rem' }}>
      <div className="admin-panel">
        <div className="admin-tabpane">
          <SignalTab notify={notify} />
        </div>
      </div>
      {toast && <div className={`admin-toast ${toast.kind === 'ok' ? 'toast-ok' : 'toast-err'}`} role="status">{toast.text}</div>}
    </div>
  )
}
