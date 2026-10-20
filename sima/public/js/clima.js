// Cálculos meteorológicos e classificação das leituras. Funções puras, sem DOM.
import { FAIXAS, VARS } from './config.js';

export const num = v => typeof v === 'number' && Number.isFinite(v);

/** Índice de calor (NOAA/Rothfusz). Abaixo de 26,7 °C a sensação ≈ temperatura. */
export function sensacao(t, u) {
  const f = t * 1.8 + 32;
  if (f < 80) return t;
  const h =
    -42.379 + 2.04901523 * f + 10.14333127 * u -
    0.22475541 * f * u - 0.00683783 * f * f -
    0.05481717 * u * u + 0.00122874 * f * f * u +
    0.00085282 * f * u * u - 0.00000199 * f * f * u * u;
  return (h - 32) / 1.8;
}

/** Ponto de orvalho (fórmula de Magnus). */
export function orvalho(t, u) {
  if (u <= 0) return NaN;
  const g = Math.log(u / 100) + (17.62 * t) / (243.12 + t);
  return (243.12 * g) / (17.62 - g);
}

/** Acrescenta as variáveis derivadas a uma leitura. */
export function enriquecer(m) {
  if (!m) return m;
  const out = { ...m };
  if (num(m.temperatura) && num(m.umidade)) {
    out.sensacao = sensacao(m.temperatura, m.umidade);
    out.orvalho = orvalho(m.temperatura, m.umidade);
  }
  return out;
}

/** Nível de uma variável: 0 bom, 1 atenção, 2 ruim, null sem dado. */
export function nivel(variavel, v) {
  const f = FAIXAS[variavel];
  if (!f || !num(v)) return null;
  let n = 0;
  if (f.alto) n = Math.max(n, v > f.alto[1] ? 2 : v > f.alto[0] ? 1 : 0);
  if (f.baixo) n = Math.max(n, v < f.baixo[1] ? 2 : v < f.baixo[0] ? 1 : 0);
  return n;
}

export const NIVEL_TXT = ['Bom', 'Atenção', 'Ruim'];

export const descricao = {
  sensacao: s => s < 15 ? 'Muito frio' : s < 18 ? 'Frio' : s < 27 ? 'Agradável' :
    s < 30 ? 'Quente' : s < 34 ? 'Muito quente' : 'Calor elevado',
  temperatura: s => descricao.sensacao(s),
  umidade: u => u < 30 ? 'Muito seco' : u < 40 ? 'Ar seco' : u <= 60 ? 'Equilibrada' :
    u <= 70 ? 'Alta' : u <= 85 ? 'Muito alta' : 'Extremamente úmida',
  co2: c => c <= 500 ? 'Nível de fundo do ar externo' : c <= 800 ? 'Levemente elevado' :
    c <= 1200 ? 'Elevado' : 'Muito elevado',
  mq135: g => g <= 100 ? 'Baixa presença de gases' : g <= 250 ? 'Presença moderada' : 'Presença alta de gases',
  orvalho: o => o < 16 ? 'Ar seco e confortável' : o < 21 ? 'Úmido' : o < 24 ? 'Abafado' : 'Muito abafado'
};

/** Avaliação geral de uma leitura: { n: 0|1|2|'d', titulo, texto, motivos } */
export function situacao(m) {
  if (!m) return { n: 'd', titulo: 'Sem medição', texto: 'Ainda não recebemos leituras deste parque.', motivos: [] };

  const motivos = [];
  const niveis = [];
  // a sensação térmica representa melhor o conforto do que a temperatura pura
  const calor = num(m.sensacao) ? 'sensacao' : 'temperatura';

  for (const k of [calor, 'umidade', 'co2', 'mq135']) {
    const n = nivel(k, m[k]);
    if (n == null) continue;
    niveis.push(n);
    if (n) motivos.push({ k, n, txt: `${VARS[k][0]}: ${descricao[k](m[k]).toLowerCase()}` });
  }

  if (!niveis.length) {
    return { n: 'd', titulo: 'Dados insuficientes', texto: 'A leitura não tem dados suficientes para uma avaliação.', motivos };
  }

  const n = Math.max(...niveis);
  const parcial = niveis.length < 4 ? ' Avaliação parcial: alguns sensores não enviaram dados.' : '';
  return {
    n,
    titulo: ['Condições favoráveis', 'Atenção', 'Condições ruins'][n],
    texto: [
      'Clima e qualidade do ar dentro das faixas consideradas adequadas.',
      'Alguns indicadores estão fora da faixa ideal. Hidrate-se e prefira a sombra.',
      'Indicadores bem fora da faixa adequada. Evite esforço físico prolongado no local.'
    ][n] + parcial,
    motivos
  };
}

/** Estatísticas descritivas de uma série [{t, v}]. Tendência = inclinação por dia. */
export function estatisticas(pts, DIA = 864e5) {
  const n = pts.length;
  if (!n) return null;
  let soma = 0, min = Infinity, max = -Infinity;
  for (const p of pts) { soma += p.v; if (p.v < min) min = p.v; if (p.v > max) max = p.v; }
  const media = soma / n;
  const dp = Math.sqrt(pts.reduce((s, p) => s + (p.v - media) ** 2, 0) / n);

  let tendencia = NaN;
  if (n > 2) {
    const mt = pts.reduce((s, p) => s + p.t, 0) / n;
    let a = 0, b = 0;
    for (const p of pts) { a += (p.t - mt) * (p.v - media); b += (p.t - mt) ** 2; }
    tendencia = b ? (a / b) * DIA : NaN;
  }
  return { n, min, max, media, dp, ultima: pts[n - 1].v, tendencia };
}

export const media = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : NaN;
