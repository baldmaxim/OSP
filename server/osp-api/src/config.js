// Настройки osp-api — только из окружения (на VPS — файл EnvironmentFile службы, права 600).
// Значения секретов никуда не выводятся: /api/health отдаёт лишь «задано / не задано».
export function loadConfig(env = process.env) {
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean)
  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT) || 8787,
    supabaseUrl: env.SUPABASE_URL || '',
    supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
    supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    s3: {
      endpoint: env.S3_ENDPOINT || '',
      region: env.S3_REGION || 'ru-central-1',
      bucket: env.S3_BUCKET || '',
      accessKeyId: env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
    },
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    ratesApiKeys: list(env.RATES_API_KEYS),
  }
}

export function configuredParts(config) {
  const s3 = config.s3
  return {
    supabase: Boolean(config.supabaseUrl && config.supabaseAnonKey),
    supabaseService: Boolean(config.supabaseUrl && config.supabaseServiceKey),
    s3: Boolean(s3.endpoint && s3.bucket && s3.accessKeyId && s3.secretAccessKey),
    anthropic: Boolean(config.anthropicApiKey),
    rates: config.ratesApiKeys.length > 0,
  }
}
