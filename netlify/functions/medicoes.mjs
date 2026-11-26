// SIMA · recebe as medições do ESP32 e entrega ao site
//   POST /api/medicoes  { "token": "...", "leituras": [ {data_hora, temperatura, umidade, indice, boot}, ... ] }
//        com "ao_vivo": true -> só guarda a leitura atual do parque (substitui a anterior), para o site
//   GET  /api/medicoes?dias=120   -> histórico + leitura ao vivo de cada parque
// Os dados ficam no Netlify Blobs (loja "sima-medicoes"), um arquivo por parque por dia.
// Quem pode gravar: variável de ambiente SIMA_DISPOSITIVOS = "token=parque" (vários separados por vírgula).
// O parque escolhido no próprio sensor (campo "parque", configurado pelo celular) tem prioridade;
// o parque da variável vale para sensores antigos que não mandam esse campo. "token=*" = só o sensor escolhe.
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

// Horário em Recife (UTC-3) no formato que o site usa
const horaRecife = ms => new Date(ms - 3 * 3600000).toISOString().slice(0, 19) + '-03:00';

// Sensor sem relógio certo manda data_hora = null e "ligado" (segundos desde que ligou).
// O servidor calcula: agora - (ligado_agora - ligado). Só vale para leituras do mesmo boot.
function horarioPeloLigado(l, ctx) {
  if (!ctx || !Number.isFinite(ctx.ligado_agora) || !Number.isFinite(l?.ligado)) return null;
  if (Number.isInteger(ctx.boot_atual) && Number.isInteger(l.boot) && l.boot !== ctx.boot_atual) return null;
  const atras = ctx.ligado_agora - l.ligado;
  if (atras < 0 || atras > 7 * 86400) return null;
  return horaRecife(Math.round((Date.now() - atras * 1000) / 1000) * 1000);
}

function linha(parque, l, agora, ctx) {
  if (!l) return null;
  let aprox = false;
  if (l.data_hora == null) {
    const h = horarioPeloLigado(l, ctx);
    if (!h) return null;
    l = { ...l, data_hora: h }; aprox = true;
  }
  if (typeof l.data_hora !== 'string' || !DATA_HORA.test(l.data_hora) || Number.isNaN(Date.parse(l.data_hora))) return null;
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
    ...(aprox ? { hora_aprox: true } : {}),
    recebido_em: agora
  };
}

async function receber(req, store, disp) {
  let corpo;
  try { corpo = await req.json(); } catch { return json({ erro: 'json invalido' }, 400); }
  const doToken = disp.get(String(corpo?.token || ''));
  if (!doToken) return json({ erro: 'token invalido' }, 401);
  const parque = PARQUES.has(corpo.parque) ? corpo.parque : doToken;
  if (!PARQUES.has(parque)) return json({ erro: `parque desconhecido: ${parque}` }, 400);
  const leituras = Array.isArray(corpo.leituras) ? corpo.leituras.slice(0, 500) : [];
  const agora = new Date().toISOString();
  const ctx = { ligado_agora: corpo.ligado_agora, boot_atual: corpo.boot_atual };

  if (corpo.ao_vivo) {                                   // leitura do momento: só a última fica guardada
    const r = linha(parque, leituras[leituras.length - 1], agora, ctx);
    if (!r) return json({ parque, ao_vivo: true, rejeitadas: leituras.length }, 400);
    await store.setJSON(`aovivo/${parque}`, { ...r, ao_vivo: true });
    return json({ parque, ao_vivo: true, data_hora: r.data_hora, co2eq: r.co2eq });
  }

  const porDia = new Map();
  let rejeitadas = 0;
  for (const l of leituras) {
    const r = linha(parque, l, agora, ctx);
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
  const chaves = [], vivas = [];
  for (const { key } of blobs) {
    const [p, d] = key.split('/');
    if (p === 'aovivo') { if (!so || d === so) vivas.push(key); }
    else if (d >= desde && (!so || p === so)) chaves.push(key);
  }
  const todas = [];
  for (let i = 0; i < chaves.length; i += 40) {
    const lote = await Promise.all(chaves.slice(i, i + 40).map(k => store.get(k, { type: 'json' })));
    for (const arr of lote) if (Array.isArray(arr)) todas.push(...arr);
  }
  // leitura ao vivo de cada parque (se for mais nova que o histórico daquele parque)
  const ultimo = new Map();
  for (const m of todas) ultimo.set(m.parque, Math.max(ultimo.get(m.parque) || 0, Date.parse(m.data_hora)));
  for (const v of await Promise.all(vivas.map(k => store.get(k, { type: 'json' })))) {
    if (v && Date.parse(v.data_hora) > (ultimo.get(v.parque) || 0)) todas.push(v);
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
