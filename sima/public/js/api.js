// Camada de dados. O resto do site só conversa com este módulo.
//
// Modo "api":   busca no servidor Node/SQLite (dados ao vivo dos sensores).
// Modo "local": se a API não responder, carrega um JSON estático e faz as
//               mesmas contas no navegador. Serve para hospedar uma versão de
//               demonstração em qualquer lugar (GitHub Pages, por exemplo).
import { API, SENSORES } from './config.js';

const HORA = 3600e3, DIA = 24 * HORA;
const OFF = -3 * HORA; // Recife, UTC−3

let modo = null;   // 'api' | 'local'
let local = null;  // leituras carregadas do arquivo (modo local)
const cache = new Map();

async function getJson(url, timeout = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

const qs = f => new URLSearchParams({
  parques: f.parques.join(','),
  de: Math.round(f.de), ate: Math.round(f.ate),
  ...(f.agrupar ? { agrupar: f.agrupar } : {})
});

/** Busca com cache curto, para não repetir a mesma consulta a cada clique. */
async function comCache(chave, fn, ttl = 30_000) {
  const c = cache.get(chave);
  if (c && Date.now() - c.t < ttl) return c.v;
  const v = await fn();
  cache.set(chave, { v, t: Date.now() });
  return v;
}

export const limparCache = () => cache.clear();
export const modoAtual = () => modo;

/* ---------------- modo local ---------------- */
async function carregarLocal() {
  if (local) return local;
  const json = await getJson(API.ARQUIVO_LOCAL, 15000);
  const lista = Array.isArray(json) ? json : json.medicoes;
  const unicas = new Map();
  for (const m of lista) {
    const t = typeof m.t === 'number' ? m.t : Date.parse(m.data_hora ?? m.medido_em);
    if (!Number.isFinite(t)) continue;
    const parque = m.parque === 'pina' ? 'governador-eduardo-campos' : m.parque;
    unicas.set(`${parque}|${t}`, { parque, t, ...Object.fromEntries(SENSORES.map(k => [k, m[k] ?? null])) });
  }
  local = {
    parques: json.parques || null,
    linhas: [...unicas.values()].sort((a, b) => a.t - b.t)
  };
  return local;
}

const filtrar = f => local.linhas.filter(l => f.parques.includes(l.parque) && l.t > f.de && l.t <= f.ate);

/** Agrupa leituras e tira a média de cada sensor. grupo(l) devolve [chave, campos fixos]. */
function agruparLocal(linhas, grupo) {
  const g = new Map();
  for (const l of linhas) {
    const [k, base] = grupo(l);
    if (!g.has(k)) g.set(k, { ...base, n: 0, s: {}, c: {} });
    const a = g.get(k);
    a.n++;
    for (const c of SENSORES) if (l[c] != null) { a.s[c] = (a.s[c] || 0) + l[c]; a.c[c] = (a.c[c] || 0) + 1; }
  }
  return [...g.values()].map(({ s, c, ...a }) => ({
    ...a, ...Object.fromEntries(SENSORES.map(k => [k, c[k] ? s[k] / c[k] : null]))
  }));
}

const LOCAL = {
  async parques() {
    await carregarLocal();
    const ids = local.parques?.map(p => p.id) || [...new Set(local.linhas.map(l => l.parque))];
    const ult = new Map();
    for (const l of local.linhas) ult.set(l.parque, l);
    const nomes = new Map((local.parques || []).map(p => [p.id, p]));
    const linhas = local.linhas;
    return {
      agora: Date.now(),
      periodo: { ini: linhas[0]?.t ?? null, fim: linhas.at(-1)?.t ?? null, total: linhas.length },
      parques: ids.map(id => {
        const u = ult.get(id);
        return {
          id, nome: nomes.get(id)?.nome || id, bairro: nomes.get(id)?.bairro || null,
          ultima: u ? { medido_em: u.t, ...Object.fromEntries(SENSORES.map(k => [k, u[k]])) } : null
        };
      })
    };
  },
  async medicoes(f) {
    await carregarLocal();
    const linhas = filtrar(f);
    const dur = f.ate - f.de;
    const ag = f.agrupar && f.agrupar !== 'auto' ? f.agrupar : dur <= 2 * DIA ? 'nenhum' : dur <= 45 * DIA ? 'hora' : 'dia';
    if (ag === 'nenhum') return linhas.map(l => ({ ...l, n: 1 }));
    const passo = ag === 'dia' ? DIA : HORA;
    return agruparLocal(linhas, l => {
      const t = Math.floor((l.t + OFF) / passo) * passo - OFF;
      return [`${l.parque}|${t}`, { parque: l.parque, t }];
    }).sort((a, b) => a.t - b.t);
  },
  async perfil(f) {
    await carregarLocal();
    return agruparLocal(filtrar(f), l => {
      const hora = Math.floor(((l.t + OFF) % DIA + DIA) % DIA / HORA);
      return [`${l.parque}|${hora}`, { parque: l.parque, hora }];
    });
  },
  async estatisticas(f) {
    await carregarLocal();
    const por = new Map();
    for (const l of filtrar(f)) {
      if (!por.has(l.parque)) por.set(l.parque, []);
      por.get(l.parque).push(l);
    }
    return [...por].map(([parque, ls]) => {
      const out = { parque, registros: ls.length };
      for (const c of SENSORES) {
        const v = ls.map(l => l[c]).filter(x => x != null);
        if (!v.length) { out[c] = null; continue; }
        const media = v.reduce((s, x) => s + x, 0) / v.length;
        out[c] = {
          n: v.length, min: Math.min(...v), max: Math.max(...v), media,
          dp: Math.sqrt(v.reduce((s, x) => s + (x - media) ** 2, 0) / v.length)
        };
      }
      return out;
    });
  }
};

/* ---------------- modo API ---------------- */
const REMOTO = {
  parques: () => getJson(`${API.BASE}/api/parques`),
  medicoes: async f => (await getJson(`${API.BASE}/api/medicoes?${qs(f)}`)).medicoes,
  perfil: async f => (await getJson(`${API.BASE}/api/perfil?${qs(f)}`)).perfil,
  estatisticas: async f => (await getJson(`${API.BASE}/api/estatisticas?${qs(f)}`)).estatisticas
};

const fonte = () => modo === 'api' ? REMOTO : LOCAL;

/* ---------------- interface pública ---------------- */
export async function parques() {
  if (modo === null) {
    try {
      const r = await REMOTO.parques();
      modo = 'api';
      return r;
    } catch (e) {
      console.warn('SIMA: API indisponível, usando arquivo local.', e);
      modo = 'local';
    }
  }
  return comCache('parques', () => fonte().parques(), 15_000);
}

export const medicoes = f => comCache('m' + qs(f), () => fonte().medicoes(f));
export const perfil = f => comCache('p' + qs(f), () => fonte().perfil(f));
export const estatisticas = f => comCache('e' + qs(f), () => fonte().estatisticas(f));

/** Baixa CSV com as leituras brutas do filtro. */
export async function baixarCsv(f, nomes) {
  if (modo === 'api') {
    location.href = `${API.BASE}/api/medicoes.csv?${qs({ ...f, agrupar: 'nenhum' })}`;
    return;
  }
  const linhas = await LOCAL.medicoes({ ...f, agrupar: 'nenhum' });
  const csv = ['parque,nome,data_hora,' + SENSORES.join(',')]
    .concat(linhas.map(l => [l.parque, `"${nomes(l.parque)}"`, new Date(l.t).toISOString(),
      ...SENSORES.map(k => l[k] ?? '')].join(',')))
    .join('\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'sima-medicoes.csv' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
