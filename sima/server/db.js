// Acesso ao banco SQLite. Usa o módulo nativo do Node (node:sqlite, Node >= 22.5),
// então não há nada para compilar ou instalar.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const CFG = require('./config');

const PARQUES_INICIAIS = [
  ['dois-irmaos', 'Parque Dois Irmãos', 'Dois Irmãos'],
  ['macaxeira', 'Parque da Macaxeira', 'Macaxeira'],
  ['tamarineira', 'Parque da Tamarineira', 'Tamarineira'],
  ['jardim-poco', 'Jardim do Poço', 'Poço da Panela'],
  ['jaqueira', 'Parque da Jaqueira', 'Jaqueira'],
  ['governador-eduardo-campos', 'Parque Gov. Eduardo Campos', 'Pina']
];

const CAMPOS = ['temperatura', 'umidade', 'co2', 'mq135'];
const HORA = 3_600_000;
const DIA = 24 * HORA;

fs.mkdirSync(path.dirname(CFG.DB_PATH), { recursive: true });
const db = new DatabaseSync(CFG.DB_PATH);

// WAL: leituras do site não bloqueiam a escrita dos sensores
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// ---------- migrações ----------
// Para mudar o esquema no futuro, adicione uma função nova no fim da lista.
const MIGRACOES = [
  () => {
    const ins = db.prepare('INSERT OR IGNORE INTO parques (id, nome, bairro) VALUES (?, ?, ?)');
    for (const p of PARQUES_INICIAIS) ins.run(...p);
  }
];

const versaoAtual = db.prepare('SELECT COALESCE(MAX(versao), 0) v FROM schema_versao').get().v;
for (let v = versaoAtual; v < MIGRACOES.length; v++) {
  transacao(() => {
    MIGRACOES[v]();
    db.prepare('INSERT INTO schema_versao (versao) VALUES (?)').run(v + 1);
  });
}

function transacao(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const plain = row => row && { ...row };

// ---------- consultas preparadas ----------
const Q = {
  parques: db.prepare('SELECT id, nome, bairro, latitude, longitude FROM parques WHERE ativo = 1 ORDER BY rowid'),
  parque: db.prepare('SELECT id FROM parques WHERE id = ? AND ativo = 1'),

  // última leitura de cada parque (usa o índice parque+data)
  ultimas: db.prepare(`
    SELECT m.parque_id, m.medido_em, m.temperatura, m.umidade, m.co2, m.mq135
    FROM medicoes m
    JOIN (SELECT parque_id, MAX(medido_em) mx FROM medicoes GROUP BY parque_id) u
      ON u.parque_id = m.parque_id AND u.mx = m.medido_em`),

  inserir: db.prepare(`
    INSERT OR IGNORE INTO medicoes (parque_id, dispositivo_id, medido_em, temperatura, umidade, co2, mq135)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),

  dispositivo: db.prepare('SELECT id, parque_id, nome, ultimo_contato FROM dispositivos WHERE token_hash = ? AND ativo = 1'),
  contato: db.prepare('UPDATE dispositivos SET ultimo_contato = ?, firmware = COALESCE(?, firmware) WHERE id = ?'),
  novoDispositivo: db.prepare('INSERT INTO dispositivos (parque_id, nome, token_hash) VALUES (?, ?, ?)'),
  dispositivos: db.prepare(`
    SELECT d.id, d.parque_id, d.nome, d.ativo, d.firmware, d.ultimo_contato,
           (SELECT COUNT(*) FROM medicoes m WHERE m.dispositivo_id = d.id) AS medicoes
    FROM dispositivos d ORDER BY d.id`),
  desativar: db.prepare('UPDATE dispositivos SET ativo = 0 WHERE id = ?'),

  resumo: db.prepare('SELECT COUNT(*) n, MIN(medido_em) ini, MAX(medido_em) fim FROM medicoes')
};

// ---------- API do módulo ----------
function listarParques() {
  const ult = new Map(Q.ultimas.all().map(r => [r.parque_id, plain(r)]));
  return Q.parques.all().map(p => {
    const u = ult.get(p.id);
    if (u) delete u.parque_id;
    return { ...p, ultima: u || null };
  });
}

const parqueExiste = id => !!Q.parque.get(id);

/** Insere várias leituras numa transação. Duplicadas (mesmo parque + horário) são ignoradas. */
function inserirMedicoes(parqueId, dispositivoId, leituras) {
  return transacao(() => {
    let inseridas = 0;
    for (const l of leituras) {
      const r = Q.inserir.run(parqueId, dispositivoId, l.medido_em,
        l.temperatura, l.umidade, l.co2, l.mq135);
      inseridas += Number(r.changes);
    }
    return { inseridas, duplicadas: leituras.length - inseridas };
  });
}

/**
 * Série temporal de um ou mais parques.
 * agrupar: 'nenhum' | '5min' | 'hora' | 'dia'. Com agrupamento, cada linha é a média do intervalo.
 */
function serie({ parques, de, ate, agrupar = 'nenhum' }) {
  const ph = parques.map(() => '?').join(',');
  const filtro = `parque_id IN (${ph}) AND medido_em > ? AND medido_em <= ?`;
  const args = [...parques, de, ate];

  if (agrupar === 'nenhum') {
    return db.prepare(`
      SELECT parque_id AS parque, medido_em AS t, ${CAMPOS.join(', ')}, 1 AS n
      FROM medicoes WHERE ${filtro}
      ORDER BY medido_em LIMIT ${CFG.MAX_LINHAS_BRUTAS}`).all(...args).map(plain);
  }

  const passo = { '5min': 5 * 60_000, hora: HORA, dia: DIA }[agrupar];
  if (!passo) throw new Error('agrupar inválido');
  // desloca pelo fuso para que "dia" comece à meia-noite local
  const off = CFG.TZ_OFFSET_MIN * 60_000;
  const bucket = `(((medido_em + ${off}) / ${passo}) * ${passo} - ${off})`;
  const media = CAMPOS.map(c => `ROUND(AVG(${c}), 2) AS ${c}`).join(', ');

  return db.prepare(`
    SELECT parque_id AS parque, ${bucket} AS t, ${media}, COUNT(*) AS n
    FROM medicoes WHERE ${filtro}
    GROUP BY parque_id, ${bucket}
    ORDER BY t`).all(...args).map(plain);
}

/** Média de cada variável por hora do dia (0–23, horário local): o "ciclo diário". */
function perfilHorario({ parques, de, ate }) {
  const ph = parques.map(() => '?').join(',');
  const off = CFG.TZ_OFFSET_MIN * 60_000;
  const media = CAMPOS.map(c => `ROUND(AVG(${c}), 2) AS ${c}`).join(', ');
  return db.prepare(`
    SELECT parque_id AS parque, ((medido_em + ${off}) / ${HORA}) % 24 AS hora, ${media}, COUNT(*) AS n
    FROM medicoes
    WHERE parque_id IN (${ph}) AND medido_em > ? AND medido_em <= ?
    GROUP BY parque_id, hora ORDER BY hora`).all(...parques, de, ate).map(plain);
}

/** Estatísticas sobre as leituras brutas (não sobre médias), por parque e variável. */
function estatisticas({ parques, de, ate }) {
  const ph = parques.map(() => '?').join(',');
  const cols = CAMPOS.map(c =>
    `COUNT(${c}) AS ${c}_n, MIN(${c}) AS ${c}_min, MAX(${c}) AS ${c}_max,
     AVG(${c}) AS ${c}_media, AVG(${c} * ${c}) AS ${c}_q`).join(',');
  const linhas = db.prepare(`
    SELECT parque_id AS parque, COUNT(*) AS registros, ${cols}
    FROM medicoes
    WHERE parque_id IN (${ph}) AND medido_em > ? AND medido_em <= ?
    GROUP BY parque_id`).all(...parques, de, ate);

  return linhas.map(l => {
    const out = { parque: l.parque, registros: l.registros };
    for (const c of CAMPOS) {
      const n = l[`${c}_n`];
      out[c] = n ? {
        n, min: l[`${c}_min`], max: l[`${c}_max`], media: l[`${c}_media`],
        dp: Math.sqrt(Math.max(0, l[`${c}_q`] - l[`${c}_media`] ** 2))
      } : null;
    }
    return out;
  });
}

function autenticar(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  return plain(Q.dispositivo.get(hash(token)));
}

function registrarContato(id, firmware) {
  Q.contato.run(Date.now(), firmware ?? null, id);
}

/** Cria um dispositivo e devolve o token (mostrado UMA vez; só o hash fica no banco). */
function criarDispositivo(parqueId, nome) {
  if (!parqueExiste(parqueId)) throw new Error(`Parque "${parqueId}" não existe.`);
  const token = 'sima_' + crypto.randomBytes(24).toString('base64url');
  const r = Q.novoDispositivo.run(parqueId, nome, hash(token));
  return { id: Number(r.lastInsertRowid), token };
}

module.exports = {
  db, CAMPOS, transacao,
  listarParques, parqueExiste, inserirMedicoes, serie, perfilHorario, estatisticas,
  autenticar, registrarContato, criarDispositivo,
  listarDispositivos: () => Q.dispositivos.all().map(plain),
  desativarDispositivo: id => Q.desativar.run(id).changes > 0,
  resumo: () => plain(Q.resumo.get())
};
