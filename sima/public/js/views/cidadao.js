// Aba "Para o cidadão": situação atual de um parque, explicada de forma simples.
import * as api from '../api.js';
import { VARS, ESCALA, FAIXAS, DIA, LEITURA_ANTIGA_MS } from '../config.js';
import { num, enriquecer, situacao, nivel, descricao, media, NIVEL_TXT } from '../clima.js';
import { el, fmt, quando, ha, hora, painel, secao, segmentado, vazio } from '../ui.js';
import { grafico, sparkline } from '../grafico.js';

const ICONE = { 0: '✓', 1: '!', 2: '×', d: '?' };

// Estado local da aba (sobrevive entre renders)
const L = { varGrafico: 'temperatura', varComp: 'sensacao' };

/** Faixas de referência de uma variável, para sombrear o gráfico. */
export function faixasDe(k) {
  const f = FAIXAS[k];
  if (!f) return [];
  const out = [];
  if (f.alto) out.push({ de: f.alto[0], ate: f.alto[1], cls: 'warn' }, { de: f.alto[1], cls: 'bad' });
  if (f.baixo) out.push({ de: f.baixo[1], ate: f.baixo[0], cls: 'warn' }, { ate: f.baixo[1], cls: 'bad' });
  return out;
}

/** Separa linhas da API por parque e devolve séries [{t, v}] por variável. */
function porParque(linhas) {
  const m = new Map();
  for (const l of linhas) {
    const e = enriquecer(l);
    if (!m.has(l.parque)) m.set(l.parque, []);
    m.get(l.parque).push(e);
  }
  return m;
}
const pts = (linhas = [], k) => linhas.filter(l => num(l[k])).map(l => ({ t: l.t, v: l[k] }));

/* ---------------- componentes ---------------- */
function seletorParques(ctx) {
  const lista = el('div', 'park-picker');
  lista.setAttribute('role', 'listbox');
  lista.setAttribute('aria-label', 'Escolha um parque');
  for (const p of ctx.parques) {
    const s = situacao(p.ultima);
    const b = el('button', 'park-chip s' + s.n, [el('i', 'dot'), el('span', '', p.nome)]);
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(p.id === ctx.S.parque));
    b.title = s.titulo;
    b.onclick = () => { ctx.S.parque = p.id; ctx.render(); };
    lista.append(b);
  }
  return lista;
}

function hero(ctx, m, s) {
  const p = ctx.parques.find(x => x.id === ctx.S.parque);
  const antiga = m && Date.now() - m.medido_em > LEITURA_ANTIGA_MS;

  const temp = el('div', 'hero-temp', [
    el('span', 'big', num(m?.temperatura) ? fmt(m.temperatura, 0) : '—'),
    el('span', 'deg', '°C')
  ]);

  const info = el('div', 'hero-info', [
    el('p', 'hero-place', p?.bairro ? `Recife · ${p.bairro}` : 'Recife'),
    el('h2', '', p?.nome || '—'),
    num(m?.sensacao) && el('p', 'hero-feel', [
      'Sensação de ', el('strong', '', fmt(m.sensacao, 0) + '°'), ` · ${descricao.sensacao(m.sensacao).toLowerCase()}`
    ]),
    el('p', 'hero-time', m
      ? [`Atualizado ${ha(m.medido_em)}`, el('span', 'sep', '·'), quando(m.medido_em)]
      : 'Nenhuma medição recebida deste parque.')
  ]);

  const veredito = el('div', 'verdict', [
    el('span', 'ico', ICONE[s.n]),
    el('div', '', [
      el('b', '', s.titulo),
      el('p', '', s.texto),
      s.motivos.length > 0 && el('ul', 'reasons', s.motivos.map(r => el('li', 'n' + r.n, r.txt))),
      antiga && el('p', 'stale', `⚠ A leitura mais recente deste parque é de ${quando(m.medido_em)}. O sensor pode estar desligado.`)
    ])
  ]);

  return el('section', 'hero s' + s.n, [el('div', 'hero-top', [temp, info]), veredito]);
}

/** Medidor horizontal: barra com zonas e marcador na posição do valor. */
function medidor(k, v) {
  const [a, b] = ESCALA[k];
  const pos = x => Math.min(100, Math.max(0, ((x - a) / (b - a)) * 100));
  const bar = el('div', 'gauge');
  // zonas coloridas conforme as faixas
  const f = FAIXAS[k];
  const cortes = [a, ...(f.baixo ? [...f.baixo].reverse() : []), ...(f.alto || []), b];
  const niveis = [...(f.baixo ? [2, 1] : []), 0, ...(f.alto ? [1, 2] : [])];
  for (let i = 0; i < cortes.length - 1; i++) {
    const z = el('i', 'z' + niveis[i]);
    z.style.left = pos(cortes[i]) + '%';
    z.style.width = (pos(cortes[i + 1]) - pos(cortes[i])) + '%';
    bar.append(z);
  }
  if (num(v)) {
    const mk = el('b', 'mk');
    mk.style.left = pos(v) + '%';
    bar.append(mk);
  }
  bar.setAttribute('aria-hidden', 'true');
  return bar;
}

function cartaoMetrica(k, m, serie24, cor) {
  const [nome, un, casas] = VARS[k];
  const v = m?.[k];
  const n = nivel(k, v);
  const c = el('article', 'metric' + (n != null ? ' n' + n : ''), [
    el('header', '', [el('span', 'metric-name', nome), n != null && el('span', 'pill n' + n, NIVEL_TXT[n])]),
    el('div', 'metric-value', [el('strong', '', fmt(v, k === 'sensacao' ? 0 : casas)), el('span', '', un)]),
    el('p', 'metric-desc', num(v) ? descricao[k](v) : 'Sem medição'),
    ESCALA[k] && medidor(k, v),
    serie24.length > 1 && el('div', 'metric-spark', [sparkline(serie24, cor), el('span', '', '24 h')])
  ]);
  return c;
}

function comparacao(ctx, dados) {
  const box = el('div');
  const desenhar = () => {
    const k = L.varComp;
    const [nome, un, casas] = VARS[k];
    const itens = ctx.parques.map(p => {
      const ult = p.ultima;
      const serie = pts(dados.get(p.id)?.filter(l => l.t > ctx.fim - DIA), k);
      return { p, atual: ult?.[k], med24: media(serie.map(x => x.v)) };
    }).filter(x => num(x.atual) || num(x.med24));

    if (!itens.length) { box.replaceChildren(vazio('Nenhuma medição disponível para comparação.')); return; }
    itens.sort((a, b) => (b.atual ?? b.med24) - (a.atual ?? a.med24));
    const max = Math.max(...itens.map(x => Math.max(x.atual ?? 0, x.med24 ?? 0)));
    const lo = Math.min(0, ESCALA[k]?.[0] ?? 0);

    const lista = el('ol', 'bars');
    for (const x of itens) {
      const val = x.atual ?? x.med24;
      const n = nivel(k, val) ?? 'd';
      const w = ((val - lo) / ((max - lo) || 1)) * 100;
      const barra = el('span', 'bar-fill n' + n);
      barra.style.width = Math.max(4, w) + '%';
      const btn = el('button', 'bar-row', [
        el('span', 'bar-name', x.p.nome),
        el('span', 'bar-track', barra),
        el('span', 'bar-val', [el('strong', '', `${fmt(val, k === 'temperatura' || k === 'sensacao' ? 1 : casas)} ${un}`),
          num(x.med24) && el('small', '', `média 24 h: ${fmt(x.med24, casas)}`)])
      ]);
      btn.type = 'button';
      btn.onclick = () => { ctx.S.parque = x.p.id; ctx.render(); scrollTo({ top: 0, behavior: 'smooth' }); };
      lista.append(el('li', x.p.id === ctx.S.parque ? 'atual' : '', btn));
    }
    box.replaceChildren(lista, el('p', 'mute small', `Valores da leitura mais recente de cada parque, ordenados do maior para o menor. Toque em um parque para ver os detalhes.`));
  };

  const ctl = segmentado('Indicador', [['sensacao', 'Sensação'], ['umidade', 'Umidade'], ['co2', 'CO₂'], ['mq135', 'Gases']],
    L.varComp, v => { L.varComp = v; desenhar(); });
  desenhar();
  return painel('Comparar parques', box, ctl);
}

function dicas(s, m) {
  const ks = new Set(s.motivos.map(r => r.k));
  const lista = [];
  if (ks.has('sensacao') || ks.has('temperatura')) {
    lista.push(['☀️', 'Calor', num(m?.sensacao) && m.sensacao >= 32
      ? 'Evite atividade física intensa entre 10h e 16h. Beba água mesmo sem sede e procure sombra.'
      : 'Prefira caminhos sombreados e leve água.']);
  }
  if (ks.has('umidade')) {
    lista.push(['💧', 'Umidade', m.umidade > 70
      ? 'Ar muito úmido dificulta o suor de evaporar: o corpo esfria menos e cansa mais rápido.'
      : 'Ar seco: hidrate-se e proteja olhos e lábios.']);
  }
  if (ks.has('co2') || ks.has('mq135')) {
    lista.push(['🌬️', 'Qualidade do ar', 'Concentração de gases acima do esperado para área aberta, possivelmente por trânsito próximo ou pouca ventilação. Pessoas com asma ou problemas respiratórios devem ficar atentas.']);
  }
  if (!lista.length && s.n === 0) {
    lista.push(['🌳', 'Bom momento', 'As condições estão adequadas para caminhadas, exercícios e lazer ao ar livre.']);
  }
  if (!lista.length) return null;
  return el('div', 'tips', lista.map(([ic, t, x]) => el('article', 'tip-card', [el('span', 'tip-ico', ic), el('div', '', [el('h4', '', t), el('p', '', x)])])));
}

/* ---------------- tela ---------------- */
export async function telaCidadao(ctx) {
  const id = ctx.S.parque;
  const m = ctx.ultima(id);
  const s = situacao(m);
  const cor = ctx.cor(id);

  // Uma consulta traz 48 h de todos os parques (gráficos, comparação e "hoje × ontem")
  const linhas = await api.medicoes({ parques: ctx.parques.map(p => p.id), de: ctx.fim - 2 * DIA, ate: ctx.fim });
  const dados = porParque(linhas);
  const meu = dados.get(id) || [];
  const hoje = meu.filter(l => l.t > ctx.fim - DIA);
  const ontem = meu.filter(l => l.t <= ctx.fim - DIA);

  const raiz = el('div', 'view');
  raiz.append(seletorParques(ctx), hero(ctx, m, s));

  // Cartões
  const cards = el('div', 'metrics');
  for (const k of ['sensacao', 'umidade', 'co2', 'mq135']) cards.append(cartaoMetrica(k, m, pts(hoje, k), cor));
  raiz.append(secao('Agora no parque'), cards);

  const dicasEl = dicas(s, m);
  if (dicasEl) raiz.append(secao('O que isso significa para você'), dicasEl);

  // Extras: orvalho e hoje × ontem
  const tH = media(pts(hoje, 'temperatura').map(p => p.v));
  const tO = media(pts(ontem, 'temperatura').map(p => p.v));
  const extras = el('div', 'facts', [
    el('div', 'fact', [el('span', '', 'Ponto de orvalho'), el('strong', '', num(m?.orvalho) ? fmt(m.orvalho, 1) + ' °C' : '—'),
      el('small', '', num(m?.orvalho) ? descricao.orvalho(m.orvalho) : '')]),
    el('div', 'fact', [el('span', '', 'Hoje × ontem'),
      el('strong', '', num(tH) && num(tO) ? `${tH >= tO ? '+' : '−'}${fmt(Math.abs(tH - tO), 1)} °C` : '—'),
      el('small', '', num(tH) && num(tO) ? 'Temperatura média, últimas 24 h vs. 24 h anteriores' : 'Precisa de 2 dias de medições')]),
    el('div', 'fact', [el('span', '', 'Máx. e mín. em 24 h'),
      el('strong', '', (() => { const v = pts(hoje, 'temperatura').map(p => p.v); return v.length ? `${fmt(Math.max(...v), 0)}° / ${fmt(Math.min(...v), 0)}°` : '—'; })()),
      el('small', '', 'Temperatura')])
  ]);
  raiz.append(extras);

  // Gráfico 24 h com seletor de variável
  const host = el('div', 'chart-host');
  const desenhar = () => {
    const k = L.varGrafico;
    grafico(host, [{ nome: VARS[k][0], cor, pts: pts(hoje, k) }],
      { u: VARS[k][1], d: VARS[k][2], titulo: VARS[k][0], faixas: faixasDe(k), xf: hora });
  };
  const opcoes = [['temperatura', 'Temp.'], ['umidade', 'Umidade'], ['co2', 'CO₂'], ['mq135', 'Gases']];
  const ctl = segmentado('Variável', opcoes, L.varGrafico, v => { L.varGrafico = v; desenhar(); });
  desenhar();
  raiz.append(secao('Últimas 24 horas'), painel(null, el('div', '', [el('div', 'panel-tools', ctl), host])));

  raiz.append(secao('Todos os parques'), comparacao(ctx, dados));

  const det = el('details', 'faq', [
    el('summary', '', 'Entenda os indicadores'),
    ...[
      ['Sensação térmica', 'Como o corpo percebe a combinação de temperatura e umidade. Em Recife, a umidade alta faz a sensação ficar acima da temperatura medida.'],
      ['CO₂', 'Dióxido de carbono, medido pelo sensor MG811. Ao ar livre o normal é algo perto de 420 ppm; valores bem maiores indicam fontes próximas (trânsito) ou pouca circulação de ar.'],
      ['Gases (MQ-135)', 'Sensor que reage a vários gases (amônia, benzeno, fumaça, álcool). Sem calibração específica, use como indicador de variação, não como valor exato.'],
      ['Ponto de orvalho', 'Temperatura em que o vapor do ar começaria a condensar. Quanto mais alto, mais "abafado" o ar parece.'],
      ['Sobre as medições', 'Os sensores do SIMA são de baixo custo e servem como indicadores ambientais. Não substituem estações oficiais de monitoramento.']
    ].map(([t, x]) => el('p', '', [el('strong', '', t + ': '), x]))
  ]);
  raiz.append(det);

  return raiz;
}
