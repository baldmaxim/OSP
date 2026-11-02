// API Яндекс.Карт — только там, где есть карта («Объекты»): сторонний скрипт не грузится на остальных страницах,
// в том числе на входе и в кабинете подрядчика.
const API_URL = 'https://api-maps.yandex.ru/2.1/?apikey=&lang=ru_RU'

let loading = null

export function loadYandexMaps() {
  if (window.ymaps) return Promise.resolve(window.ymaps)
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = API_URL
    script.async = true
    script.onload = () => resolve(window.ymaps)
    script.onerror = () => {
      // Следующее открытие карты попробует снова.
      loading = null
      script.remove()
      reject(new Error('Не удалось загрузить Яндекс.Карты'))
    }
    document.head.appendChild(script)
  })
  return loading
}
