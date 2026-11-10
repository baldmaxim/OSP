// Доступ к серверу — только через эти адаптеры (см. supabaseClient.js).
export { db } from './db'
export { auth } from './auth'
export { objectPhotos } from './files'
export { invokeFunction, filesViaOspApi, ospFiles, requestBidVorFile } from './functions'
export { subscribeTable } from './realtime'
export { apiKeys } from './apiKeys'
export { identityAdmin } from './identityAdmin'
export { contractorSignup, contractorSignupsAdmin, signupManual, signupOpen } from './contractorSignup'
