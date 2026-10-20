-- ============================================================
-- SIMA · Esquema do banco de dados (SQLite)
--
-- Regras gerais:
--  * Datas são guardadas como INTEGER em milissegundos UTC (epoch).
--    Isso deixa as buscas por período rápidas e evita confusão de fuso;
--    a conversão para o horário de Recife é feita só na tela.
--  * Valores derivados (sensação térmica, ponto de orvalho) NÃO são
--    guardados: são calculados na leitura a partir de temperatura e umidade.
--  * Um valor de sensor ausente ou inválido é guardado como NULL,
--    nunca como 0 (0 °C ou 0 ppm seriam leituras "verdadeiras").
-- ============================================================

PRAGMA foreign_keys = ON;

-- Locais monitorados
CREATE TABLE IF NOT EXISTS parques (
  id          TEXT PRIMARY KEY,               -- slug: 'dois-irmaos'
  nome        TEXT NOT NULL,
  bairro      TEXT,
  latitude    REAL,
  longitude   REAL,
  ativo       INTEGER NOT NULL DEFAULT 1,
  criado_em   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Cada placa (Arduino/ESP32) instalada num parque.
-- O token de acesso nunca é guardado em texto puro, só o hash SHA-256.
CREATE TABLE IF NOT EXISTS dispositivos (
  id              INTEGER PRIMARY KEY,
  parque_id       TEXT NOT NULL REFERENCES parques(id),
  nome            TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  ativo           INTEGER NOT NULL DEFAULT 1,
  firmware        TEXT,
  ultimo_contato  INTEGER,
  criado_em       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Leituras dos sensores
CREATE TABLE IF NOT EXISTS medicoes (
  id              INTEGER PRIMARY KEY,
  parque_id       TEXT NOT NULL REFERENCES parques(id),
  dispositivo_id  INTEGER REFERENCES dispositivos(id),   -- NULL = dado importado
  medido_em       INTEGER NOT NULL,                       -- quando o sensor leu
  recebido_em     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  temperatura     REAL CHECK (temperatura IS NULL OR temperatura BETWEEN -40 AND 80),
  umidade         REAL CHECK (umidade     IS NULL OR umidade     BETWEEN 0 AND 100),
  co2             REAL CHECK (co2         IS NULL OR co2         BETWEEN 0 AND 10000),
  mq135           REAL CHECK (mq135       IS NULL OR mq135       BETWEEN 0 AND 10000),
  -- evita a mesma leitura entrar duas vezes (ex.: reenvio após queda de Wi-Fi)
  UNIQUE (parque_id, medido_em)
);

-- Índice principal: quase toda consulta é "parque X entre data A e B"
CREATE INDEX IF NOT EXISTS ix_medicoes_parque_data ON medicoes (parque_id, medido_em);
CREATE INDEX IF NOT EXISTS ix_medicoes_data ON medicoes (medido_em);

-- Controle de versão do esquema (migrações)
CREATE TABLE IF NOT EXISTS schema_versao (
  versao      INTEGER PRIMARY KEY,
  aplicado_em INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
