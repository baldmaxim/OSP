// Настоящее боковое меню для стенда (?shell=1&sidebar=1): тема — своим провайдером (переключатель темы в меню),
// уведомления — запасным значением useNotifications вне провайдера.
import { ThemeProvider } from '../../../src/contexts/ThemeContext'
import Sidebar from '../../../src/components/Sidebar'

export default function SidebarStand() {
  return <ThemeProvider><Sidebar /></ThemeProvider>
}
