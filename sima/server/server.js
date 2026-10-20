// Servidor HTTP do SIMA: API REST + arquivos do site.
// Sem dependências externas — só Node.js >= 22.5.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const CFG = require('./config');
const DB = require('./db');
const { validarLeitura } = require('./validar');

const DIA = 86_400_000;

/* ============================================================
   UTILITÁRIOS HTTP
   ============================================================ */
class ErroHttp extends Error {
  constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; }
}

function cabecalhosCors(req, res) {
  const origem = req.headers.origin;
  const lista = CFG.CORS.split(',').map(s => s.trim());
  if (lista.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origem && lista.includes(origem)) {
    res.setHeader('Access-Control-Allow-Origin', origem);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(res, status, corpo, cache = 'no-store') {
  const txt = JSON.stringify(corpo);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cache,
    'Content-Length': Buffer.byteLength(txt)
  });
  res.end(txt);
}

function lerCorpo(req, limite = 512 * 1024) {
  return new Promise((ok, falha) => {
    let tam = 0;
    const partes = [];
    req.on('data', c => {
      tam += c.length;
      if (tam > limite) { falha(new ErroHttp(413, 'corpo muito grande')); req.destroy(); }
      else partes.push(c);
    });
    req.on('end', () => {
      try { ok(JSON.parse(Buffer.concat(partes).toString('utf8') || 'null')); }
      catch { falha(new ErroHttp(400, 'JSON inválido')); }
    });
    req.on('error', falha);
  });
}

function token(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : req.headers['x-api-key'];
}

/** Lê ?parques=a,b&de=&ate= e devolve um filtro validado. */
function filtroPeriodo(q) {
  const parques = (q.get('parques') || q.get('parque') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const todos = DB.listarParques().map(p => p.id);
  const ids = parques.length ? parques : todos;
  const invalido = ids.find(id => !todos.includes(id));
  if (invalido) throw new ErroHttp(400, `parque desconhecido: ${invalido}`);

  const num = (v, pad) => {
    if (v == null || v === '') return pad;
    const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
    if (!Number.isFinite(n)) throw new ErroHttp(400, `data inválida: ${v}`);
    return n;
  };
  const ate = num(q.get('ate'), Date.now());
  const de = num(q.get('de'), ate - 7 * DIA);
  if (de >= ate) throw new ErroHttp(400, '"de" deve ser anterior a "ate"');

  // agrupamento automático conforme o tamanho do período
  let agrupar = q.get('agrupar') || 'auto';
  if (agrupar === 'auto') {
    const dur = ate - de;
    agrupar = dur <= 2 * DIA ? '5min' : dur <= 45 * DIA ? 'hora' : 'dia';
  }
  if (!['nenhum', '5min', 'hora', 'dia'].includes(agrupar)) throw new ErroHttp(400, 'agrupar inválido');

  return { parques: ids, de, ate, agrupar };
}

/* ============================================================
   CONTROLE DE TAXA (por dispositivo, em memória)
   ============================================================ */
const ultimoEnvio = new Map();
function checarTaxa(dispId) {
  const agora = Date.now();
  const ant = ultimoEnvio.get(dispId) || 0;
  if (agora - ant < CFG.MIN_INTERVALO_MS) {
    throw new ErroHttp(429, 'envios muito frequentes', { tente_em_ms: CFG.MIN_INTERVALO_MS - (agora - ant) });
  }
  ultimoEnvio.set(dispId, agora);
}

/* ============================================================
   ROTAS
   ============================================================ */
const rotas = {
  'GET /api/saude': () => ({ ok: true, agora: Date.now(), ...DB.resumo() }),

  'GET /api/parques': () => {
    const r = DB.resumo();
    return { agora: Date.now(), periodo: { ini: r.ini, fim: r.fim, total: r.n }, parques: DB.listarParques() };
  },

  'GET /api/medicoes': (req, url) => {
    const f = filtroPeriodo(url.searchParams);
    return { ...f, medicoes: DB.serie(f) };
  },

  'GET /api/perfil': (req, url) => {
    const f = filtroPeriodo(url.searchParams);
    return { ...f, perfil: DB.perfilHorario(f) };
  },

  'GET /api/estatisticas': (req, url) => {
    const f = filtroPeriodo(url.searchParams);
    return { ...f, estatisticas: DB.estatisticas(f) };
  },

  'GET /api/medicoes.csv': (req, url, res) => {
    const f = filtroPeriodo(url.searchParams);
    if (!url.searchParams.get('agrupar')) f.agrupar = 'nenhum';
    const linhas = DB.serie(f);
    const cab = ['parque', 'data_hora', ...DB.CAMPOS, 'n_leituras'];
    const csv = [cab.join(',')].concat(linhas.map(l =>
      [l.parque, new Date(l.t).toISOString(), ...DB.CAMPOS.map(c => l[c] ?? ''), l.n].join(',')
    )).join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="sima-medicoes.csv"'
    });
    res.end('﻿' + csv);
  },

  // Endpoint usado pelo Arduino/ESP32.
  // Corpo: uma leitura { temperatura, umidade, co2, mq135, medido_em? }
  //    ou lote: { leituras: [ ... ], firmware?: "1.0.0" }
  'POST /api/leituras': async req => {
    const disp = DB.autenticar(token(req));
    if (!disp) throw new ErroHttp(401, 'token inválido ou dispositivo desativado');
    checarTaxa(disp.id);

    const corpo = await lerCorpo(req);
    const lista = Array.isArray(corpo) ? corpo : Array.isArray(corpo?.leituras) ? corpo.leituras : [corpo];
    if (!lista.length) throw new ErroHttp(400, 'nenhuma leitura enviada');
    if (lista.length > CFG.MAX_LOTE) throw new ErroHttp(413, `máximo de ${CFG.MAX_LOTE} leituras por envio`);

    const agora = Date.now();
    const validas = [], rejeitadas = [], avisos = [];
    lista.forEach((b, i) => {
      const r = validarLeitura(b, agora);
      if (r.avisos?.length) avisos.push({ indice: i, avisos: r.avisos });
      if (r.ok) validas.push(r.leitura);
      else rejeitadas.push({ indice: i, erro: r.erro });
    });

    const res = validas.length ? DB.inserirMedicoes(disp.parque_id, disp.id, validas) : { inseridas: 0, duplicadas: 0 };
    DB.registrarContato(disp.id, typeof corpo?.firmware === 'string' ? corpo.firmware.slice(0, 32) : null);

    return {
      _status: validas.length ? 201 : 422,
      parque: disp.parque_id,
      ...res,
      rejeitadas,
      avisos,
      hora_servidor: agora  // o Arduino pode usar para acertar o relógio
    };
  }
};

/* ============================================================
   ARQUIVOS ESTÁTICOS
   ============================================================ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

function estatico(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const arq = path.normalize(path.join(CFG.PUBLIC_DIR, rel));
  if (!arq.startsWith(CFG.PUBLIC_DIR)) { res.writeHead(403).end(); return; }

  fs.stat(arq, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(arq)] || 'application/octet-stream',
      'Cache-Control': rel.endsWith('.html') ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(arq).pipe(res);
  });
}

/* ============================================================
   SERVIDOR
   ============================================================ */
const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const inicio = Date.now();

  if (url.pathname.startsWith('/api/')) {
    cabecalhosCors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

    const rota = rotas[`${req.method} ${url.pathname}`];
    try {
      if (!rota) throw new ErroHttp(404, 'rota não encontrada');
      const r = await rota(req, url, res);
      if (r !== undefined && !res.headersSent) {
        const { _status = 200, ...corpo } = r;
        json(res, _status, corpo, req.method === 'GET' ? 'public, max-age=30' : 'no-store');
      }
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) json(res, status, { erro: status === 500 ? 'erro interno' : e.message, ...e.extra });
    }
    if (req.method !== 'GET') console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - inicio}ms`);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  estatico(req, res, url);
});

if (require.main === module) {
  servidor.listen(CFG.PORTA, () => {
    const r = DB.resumo();
    console.log(`SIMA rodando em http://localhost:${CFG.PORTA}  ·  ${r.n} medições no banco (${CFG.DB_PATH})`);
  });
}

module.exports = servidor;
