// SIMA · recebe as medições do ESP32 e entrega ao site
//   POST /api/medicoes  { "token": "...", "leituras": [ {data_hora, temperatura, umidade, indice, boot}, ... ] }
//   GET  /api/medicoes?dias=120   -> lista de medições (todas os parques)
// Os dados ficam no Netlify Blobs (loja "sima-medicoes"), um arquivo por parque por dia.
// Quem pode gravar: variável de ambiente SIMA_DISPOSITIVOS = "token=parque" (vários separados por vírgula).
import { getStore } from '@netlify/blobs';

const CO2_REF = 350, EXPOENTE = 2.849, CO2_BOM = 650;
const PARQUES = new Set(['dois-irmaos', 'macaxeira', 'tamarineira', 'jardim-poco', 'jaqueira', 'governador-eduardo-campos']);
const DATA_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }
});

export function lerDispositivos(txt = '') {
  const m = new Map();
  for (const par of String(txt).split(/[,;\s]+/)) {
    const i = par.indexOf('=');
    if (i > 0) m.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
  }
  return m;
}

const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) ? v : null;

function linha(parque, l, agora) {
  if (!l || typeof l.data_hora !== 'string' || !DATA_HORA.test(l.data_hora) || Number.isNaN(Date.parse(l.data_hora))) return null;
  const indice = num(l.indice, 0.05, 20);
  const co2eq = indice == null ? null : Math.round(CO2_REF * Math.pow(indice, EXPOENTE) * 10) / 10;
  return {
    parque,
    data_hora: l.data_hora,
    temperatura: num(l.temperatura, -40, 80),
    umidade: num(l.umidade, 0, 100),
    indice,
    co2eq,
    alerta: co2eq == null ? null : co2eq > CO2_BOM,
    boot: Number.isInteger(l.boot) ? l.boot : null,
    recebido_em: agora
  };
}

async function receber(req, store, disp) {
  let corpo;
  try { corpo = await req.json(); } catch { return json({ erro: 'json invalido' }, 400); }
  const parque = disp.get(String(corpo?.token || ''));
  if (!parque) return json({ erro: 'token invalido' }, 401);
  if (!PARQUES.has(parque)) return json({ erro: `parque desconhecido: ${parque}` }, 400);
  const leituras = Array.isArray(corpo.leituras) ? corpo.leituras.slice(0, 500) : [];

  const agora = new Date().toISOString();
  const porDia = new Map();
  let rejeitadas = 0;
  for (const l of leituras) {
    const r = linha(parque, l, agora);
    if (!r) { rejeitadas++; continue; }
    const dia = r.data_hora.slice(0, 10);                // dia local (o ESP32 manda com -03:00)
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(r);
  }

  let inseridas = 0, duplicadas = 0;
  for (const [dia, novas] of porDia) {
    const chave = `${parque}/${dia}`;
    const atuais = (await store.get(chave, { type: 'json' })) || [];
    const ja = new Set(atuais.map(x => Date.parse(x.data_hora)));
    for (const r of novas) {
      const t = Date.parse(r.data_hora);
      if (ja.has(t)) { duplicadas++; continue; }
      ja.add(t); atuais.push(r); inseridas++;
    }
    atuais.sort((a, b) => Date.parse(a.data_hora) - Date.parse(b.data_hora));
    await store.setJSON(chave, atuais);
  }
  return json({ parque, inseridas, duplicadas, rejeitadas });
}

async function listar(req, store) {
  const u = new URL(req.url);
  const dias = Math.min(Math.max(parseInt(u.searchParams.get('dias') || '120', 10) || 120, 1), 1000);
  const so = u.searchParams.get('parque');
  const desde = new Date(Date.now() - (dias + 1) * 86400000).toISOString().slice(0, 10);
  const { blobs } = await store.list();
  const chaves = blobs.map(b => b.key).filter(k => {
    const [p, d] = k.split('/');
    return d >= desde && (!so || p === so);
  });
  const todas = [];
  for (let i = 0; i < chaves.length; i += 40) {
    const lote = await Promise.all(chaves.slice(i, i + 40).map(k => store.get(k, { type: 'json' })));
    for (const arr of lote) if (Array.isArray(arr)) todas.push(...arr);
  }
  todas.sort((a, b) => Date.parse(a.data_hora) - Date.parse(b.data_hora));
  return json(todas);
}

export async function tratar(req, store, disp) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' } });
  if (req.method === 'POST') return receber(req, store, disp);
  if (req.method === 'GET') return listar(req, store);
  return json({ erro: 'metodo nao permitido' }, 405);
}

export default async (req) =>
  tratar(req, getStore({ name: 'sima-medicoes', consistency: 'strong' }), lerDispositivos(process.env.SIMA_DISPOSITIVOS));

export const config = { path: '/api/medicoes' };
