import { Component } from 'react'
import { isChunkLoadError, reloadOnceForThisBuild } from '../utils/chunkRecovery'
import './ChunkErrorBoundary.css'

// Ловит ошибку отрисовки страницы вместо белого экрана. Ошибка загрузки чанка
// (вкладка открыта до деплоя) — одна автоматическая перезагрузка, см.
// utils/chunkRecovery.js; если не помогло или ошибка другая — сообщение с кнопкой.
// resetKey (адрес страницы): при переходе на другую страницу ошибка сбрасывается.
export default class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, resetKey: props.resetKey }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  static getDerivedStateFromProps(props, state) {
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey }
    return null
  }

  componentDidCatch(error) {
    if (isChunkLoadError(error)) reloadOnceForThisBuild()
    console.error('Ошибка отрисовки страницы:', error)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const chunk = isChunkLoadError(error)
    return (
      <div className="chunk-error" role="alert">
        <div className="chunk-error-title">
          {chunk ? 'Не удалось загрузить страницу' : 'На странице произошла ошибка'}
        </div>
        <div className="chunk-error-text">
          {chunk
            ? 'Скорее всего, вышла новая версия портала. Обновите страницу.'
            : 'Обновите страницу. Если ошибка повторится — сообщите администратору.'}
        </div>
        <button type="button" className="chunk-error-reload" onClick={() => window.location.reload()}>
          Обновить
        </button>
      </div>
    )
  }
}
