// Validação das leituras enviadas pelos sensores.
// Filosofia: um sensor com defeito não deve derrubar a leitura inteira.
// Valor fora da faixa física do sensor vira NULL; o resto da leitura é aproveitado.
const CFG = require('./config');

// Faixa física de cada sensor (fora disso é falha de leitura, não clima extremo)
const FAIXAS = {
  temperatura: [-40, 80],   // DHT22
  umidade: [0, 100],        // DHT22
  co2: [0, 10000],          // MG811
  mq135: [0, 10000]         // MQ-135 (ppm equivalente)
};

// 2020-01-01: qualquer data antes disso indica relógio do Arduino não sincronizado
const DATA_MINIMA = Date.UTC(2020, 0, 1);

function lerData(v, agora) {
  if (v == null) return agora;                                // sem RTC/NTP: usa hora do servidor
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;   // aceita segundos ou ms
  const t = Date.parse(v);
  return Number.isNaN(t) ? NaN : t;
}

/**
 * Normaliza uma leitura. Devolve { ok, leitura, avisos } ou { ok:false, erro }.
 * Aceita tanto { medido_em } quanto { data_hora } (formato antigo do JSON).
 */
function validarLeitura(bruta, agora = Date.now()) {
  if (!bruta || typeof bruta !== 'object' || Array.isArray(bruta)) {
    return { ok: false, erro: 'leitura deve ser um objeto' };
  }

  const t = lerData(bruta.medido_em ?? bruta.data_hora ?? bruta.ts, agora);
  if (!Number.isFinite(t)) return { ok: false, erro: 'medido_em inválido' };
  if (t < DATA_MINIMA) return { ok: false, erro: 'medido_em antes de 2020 (relógio não sincronizado?)' };
  if (t > agora + CFG.TOLERANCIA_FUTURO_MS) return { ok: false, erro: 'medido_em no futuro' };

  const leitura = { medido_em: Math.round(t) };
  const avisos = [];
  let algum = false;

  for (const [campo, [min, max]] of Object.entries(FAIXAS)) {
    const v = bruta[campo];
    if (v == null || v === '') { leitura[campo] = null; continue; }
    const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
      leitura[campo] = null;
      avisos.push(`${campo}=${v} fora da faixa ${min}–${max}, descartado`);
      continue;
    }
    leitura[campo] = Math.round(n * 100) / 100;
    algum = true;
  }

  if (!algum) return { ok: false, erro: 'nenhum valor de sensor válido', avisos };
  return { ok: true, leitura, avisos };
}

module.exports = { validarLeitura, FAIXAS };
