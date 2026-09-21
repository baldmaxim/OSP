import { useState } from 'react'
import Sidebar from './Sidebar'
import './Layout.css'

function Layout({ children }) {
  const [activeTab, setActiveTab] = useState('contracts')

  return (
    <div className="layout">
      <Sidebar activeTab={activeTab} onTabChange={setActiveTab} />
      <main className="main-content">
        {children}
      </main>
    </div>
  )
}

export default Layout
