// Доступ к серверу — только через эти адаптеры (см. supabaseClient.js).
export { db } from './db'
export { auth } from './auth'
export { objectPhotos } from './files'
export { invokeFunction } from './functions'
export { subscribeTable } from './realtime'
