// Configuração lida de variáveis de ambiente (ou arquivo .env), com padrões seguros.
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');

// Leitor mínimo de .env (evita depender de bibliotecas externas)
const envFile = path.join(RAIZ, '.env');
if (fs.existsSync(envFile)) {
  for (const linha of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;

module.exports = {
  RAIZ,
  PORTA: Number(env.PORT) || 3000,
  DB_PATH: path.resolve(RAIZ, env.DB_PATH || 'data/sima.db'),
  PUBLIC_DIR: path.join(RAIZ, 'public'),

  // Recife não tem horário de verão: UTC−3 fixo. Usado para agrupar por dia local.
  TZ_OFFSET_MIN: Number(env.TZ_OFFSET_MIN ?? -180),

  // Proteções da API de escrita
  MAX_LOTE: 500,                 // leituras por requisição (envio em lote do buffer offline)
  MIN_INTERVALO_MS: 10_000,      // um dispositivo não pode enviar mais de 1 req a cada 10 s
  TOLERANCIA_FUTURO_MS: 10 * 60_000, // aceita relógio do Arduino até 10 min adiantado

  // Limite de linhas devolvidas sem agrupamento
  MAX_LINHAS_BRUTAS: 20_000,

  // Origens permitidas para CORS (separadas por vírgula). '*' libera todas.
  CORS: env.CORS_ORIGINS || '*'
};
