import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import '../../../src/index.css'
import PsdcPanel from '../../../src/components/psdc/PsdcPanel'
import PsdcBatchPage from '../../../src/pages/PsdcBatchPage'

const params = new URLSearchParams(window.location.search)
const view = params.get('view')

function App() {
  if (view === 'batch') return <PsdcBatchPage />
  return (
    <div style={{ padding: 16 }}>
      <PsdcPanel documentId={params.get('doc')} displayId={params.get('display')} onChanged={() => { window.__psdcChanged = (window.__psdcChanged || 0) + 1 }} />
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
)
