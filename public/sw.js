// Самоудаление чужого service worker. До 13.10.2026 на адресе tender.su10.ru жил другой портал (HUBTender,
// PWA): его service worker (/sw.js, вся область сайта) остался в браузерах тех, кто туда заходил, и на любой
// переход отдаёт из своего кэша страницу «TenderHUB» вместо портала ОСП.
//
// Портал ОСП service worker не регистрирует — этот файл никто не ставит сам. Его скачивает только браузер,
// где прежний остался: при переходах он проверяет /sw.js на сервере, видит другой файл и ставит его вместо
// прежнего. Этот сразу активируется (skipWaiting), стирает кэши прежнего сайта (портал ОСП кэшем браузера не
// пользуется), снимает регистрацию и перезагружает вкладки, которые прежний обслуживал: в них была страница
// TenderHUB, так что несохранённого в портале ОСП там нет. После перезагрузки страницы идут с сервера.
// Обработчика fetch нет: пока он жив, запросы идут в сеть как обычно.
// Проверка — tests/release/sw-cleanup.test.mjs.
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.map((key) => caches.delete(key)))
    await self.registration.unregister()
    const tabs = await self.clients.matchAll({ type: 'window' })
    await Promise.all(tabs.map((tab) => tab.navigate(tab.url).catch(() => null)))
  })())
})
