// Aba "Pesquisa": séries históricas, comparação entre parques e estatísticas.
import * as api from '../api.js';
import { VARS, PERIODOS, SENSORES, DIA } from '../config.js';
import { num, enriquecer, estatisticas as estat } from '../clima.js';
import { el, fmt, quando, painel, secao, selectCampo, segmentado, vazio } from '../ui.js';
import { grafico } from '../grafico.js';
import { faixasDe } from './cidadao.js';

const GRAN = { nenhum: 'leituras individuais', '5min': 'médias de 5 min', hora: 'médias horárias', dia: 'médias diárias' };

function chipsMultiplos(ctx) {
  const lista = el('div', 'park-picker multi');
  for (const p of ctx.parques) {
    const ativo = ctx.S.sel.has(p.id);
    const dot = el('i', 'dot');
    dot.style.background = ctx.cor(p.id);
    const b = el('button', 'park-chip', [dot, el('span', '', p.nome)]);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(ativo));
    b.onclick = () => {
      if (ativo) { if (ctx.S.sel.size > 1) ctx.S.sel.delete(p.id); }
      else ctx.S.sel.add(p.id);
      ctx.render();
    };
    lista.append(b);
  }
  return lista;
}

function tabela(cab, linhas) {
  const t = el('table', '', [
    el('thead', '', el('tr', '', cab.map(h => el('th', '', h)))),
    el('tbody', '', linhas.map(l => el('tr', '', l.map(c => el('td', '', c)))))
  ]);
  return el('div', 'tab', t);
}

export async function telaPesquisa(ctx) {
  const { S } = ctx;
  const ids = ctx.parques.map(p => p.id).filter(id => S.sel.has(id));
  const k = S.v;
  const [nomeVar, un, casas] = VARS[k];
  const derivada = !SENSORES.includes(k);

  const ate = ctx.fim;
  const de = S.per ? ate - S.per * DIA : (ctx.periodo.ini ?? ate - DIA) - 1;
  const dur = ate - de;
  const unico = ids.length === 1 && S.per > 0;
  const filtro = { parques: ids, de, ate };

  // Todas as consultas em paralelo
  const [linhas, perf, est, anteriores] = await Promise.all([
    api.medicoes(filtro),
    api.perfil(filtro),
    api.estatisticas(filtro),
    S.ant && unico ? api.medicoes({ parques: ids, de: de - dur, ate: de }) : []
  ]);

  const series = new Map(ids.map(id => [id, []]));
  for (const l of linhas) series.get(l.parque)?.push(enriquecer(l));
  const pts = (arr, kk = k, desloc = 0) => arr.filter(l => num(l[kk])).map(l => ({ t: l.t + desloc, v: l[kk] }));
  const gran = dur <= 2 * DIA ? (api.modoAtual() === 'api' ? '5min' : 'nenhum') : dur <= 45 * DIA ? 'hora' : 'dia';

  const raiz = el('div', 'view');
  raiz.append(el('div', 'research-intro', [
    el('h2', '', 'Análise comparativa'),
    el('p', 'mute', 'Compare indicadores entre parques e períodos. Os gráficos usam ' + GRAN[gran] +
      '; as estatísticas são calculadas sobre as leituras originais.')
  ]));

  // Barra de controles
  const btnCsv = el('button', 'btn', '⬇ Baixar CSV');
  btnCsv.type = 'button';
  btnCsv.onclick = () => api.baixarCsv(filtro, ctx.nome);

  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = S.ant && unico;
  cb.disabled = !unico;
  cb.onchange = () => { S.ant = cb.checked; ctx.render(); };

  raiz.append(el('div', 'toolbar', [
    el('div', 'toolbar-row', chipsMultiplos(ctx)),
    el('div', 'toolbar-row', [
      selectCampo('Variável', Object.entries(VARS).map(([c, v]) => [c, `${v[0]} (${v[1]})`]), k, v => { S.v = v; ctx.render(); }),
      segmentado('Período', PERIODOS.map(([n, v]) => [v, n]), S.per, v => { S.per = Number(v); ctx.render(); }),
      el('label', 'check' + (unico ? '' : ' disabled'), [cb, el('span', '', 'Comparar com período anterior')]),
      el('span', 'grow'),
      btnCsv
    ])
  ]));

  // Série temporal
  const hostSerie = el('div', 'chart-host');
  const ss = ids.map(id => ({ nome: ctx.nome(id), cor: ctx.cor(id), pts: pts(series.get(id)) }));
  if (anteriores.length) {
    ss.push({ nome: ctx.nome(ids[0]) + ' (período anterior)', cor: ctx.cor(ids[0]), tracejada: true,
      pts: pts(anteriores.map(enriquecer), k, dur) });
  }
  grafico(hostSerie, ss, { u: un, d: casas, titulo: nomeVar, faixas: ids.length === 1 ? faixasDe(k) : [] });
  raiz.append(painel(`${nomeVar} ao longo do tempo`, hostSerie));

  // Perfil horário + estatísticas
  const hostPerfil = el('div', 'chart-host');
  const porParque = new Map(ids.map(id => [id, []]));
  for (const p of perf) porParque.get(p.parque)?.push(enriquecer(p));
  grafico(hostPerfil,
    ids.map(id => ({
      nome: ctx.nome(id), cor: ctx.cor(id),
      pts: porParque.get(id).filter(l => num(l[k])).map(l => ({ t: l.hora, v: l[k] })).sort((a, b) => a.t - b.t)
    })),
    { u: un, d: casas, titulo: 'Perfil médio por hora', area: false, xf: t => Math.round(t) + 'h', tf: t => `${Math.round(t)}h – ${Math.round(t) + 1}h` });

  const estServ = new Map(est.map(e => [e.parque, e]));
  const linhasTab = ids.map(id => {
    const s = estat(pts(series.get(id)));
    // para variáveis medidas usamos as estatísticas do banco (leituras brutas)
    const b = !derivada && estServ.get(id)?.[k];
    const r = b ? { n: b.n, min: b.min, max: b.max, media: b.media, dp: b.dp } : s;
    if (!r) return [ctx.nome(id), '0', '—', '—', '—', '—', '—', '—'];
    return [
      ctx.nome(id), r.n.toLocaleString('pt-BR'), fmt(r.min, casas), fmt(r.media, casas), fmt(r.max, casas),
      fmt(r.dp, casas + 1), fmt(s?.ultima, casas),
      num(s?.tendencia) ? `${s.tendencia >= 0 ? '+' : '−'}${fmt(Math.abs(s.tendencia), casas + 1)} ${un}/dia` : '—'
    ];
  });

  raiz.append(
    painel('Perfil médio por hora do dia', el('div', '', [hostPerfil,
      el('p', 'mute small', 'Média de todas as leituras de cada horário no período. Mostra o ciclo típico do dia.')])),
    painel('Estatísticas do período', el('div', '', [
      tabela(['Parque', 'Leituras', 'Mín.', 'Média', 'Máx.', 'Desvio', 'Última', 'Tendência'], linhasTab),
      derivada && el('p', 'mute small', `${nomeVar} é calculada a partir de temperatura e umidade; estatísticas sobre ${GRAN[gran]}.`)
    ]))
  );

  // Painel com todas as variáveis do primeiro parque
  const primeiro = ids[0];
  if (primeiro) {
    raiz.append(secao(`Todas as variáveis · ${ctx.nome(primeiro)}`));
    const mini = el('div', 'mini');
    for (const v of Object.keys(VARS)) {
      const h = el('div', 'chart-host');
      grafico(h, [{ nome: VARS[v][0], cor: ctx.cor(primeiro), pts: pts(series.get(primeiro), v) }],
        { u: VARS[v][1], d: VARS[v][2], h: 200, titulo: VARS[v][0] });
      mini.append(painel(`${VARS[v][0]} (${VARS[v][1]})`, h));
    }
    raiz.append(mini);
  }

  // Qualidade / cobertura
  const registros = est.reduce((s, e) => s + e.registros, 0);
  const validos = est.reduce((s, e) => s + SENSORES.reduce((x, c) => x + (e[c]?.n || 0), 0), 0);
  const cob = registros ? (validos / (registros * SENSORES.length)) * 100 : NaN;
  raiz.append(secao('Qualidade e cobertura dos dados'), el('div', 'facts', [
    el('div', 'fact', [el('span', '', 'Leituras no período'), el('strong', '', registros.toLocaleString('pt-BR')),
      el('small', '', `${ids.length} parque${ids.length > 1 ? 's' : ''} selecionado${ids.length > 1 ? 's' : ''}`)]),
    el('div', 'fact', [el('span', '', 'Completude'), el('strong', '', num(cob) ? fmt(cob, 1) + '%' : '—'),
      el('small', '', 'Campos de sensor preenchidos')]),
    el('div', 'fact', [el('span', '', 'Leitura mais recente'), el('strong', '', ctx.periodo.fim ? quando(ctx.periodo.fim) : '—'),
      el('small', '', api.modoAtual() === 'api' ? 'Banco de dados ao vivo' : 'Arquivo de demonstração')])
  ]));

  // Dados (agregados) recentes
  const recentes = linhas.slice().sort((a, b) => b.t - a.t).slice(0, 100);
  raiz.append(el('details', 'faq', [
    el('summary', '', `Ver dados do período (${GRAN[gran]})`),
    recentes.length
      ? tabela(['Parque', 'Data/hora', 'Temp.', 'Umidade', 'CO₂', 'MQ-135', 'Leituras'], recentes.map(m => [
        ctx.nome(m.parque), quando(m.t), fmt(m.temperatura, 1) + ' °C', fmt(m.umidade, 0) + '%',
        fmt(m.co2, 0) + ' ppm', fmt(m.mq135, 0), String(m.n ?? 1)
      ]))
      : vazio('Sem dados.'),
    linhas.length > 100 && el('p', 'mute small', 'Mostrando as 100 linhas mais recentes. Use "Baixar CSV" para obter todas as leituras originais.')
  ]));

  raiz.append(el('details', 'faq', [
    el('summary', '', 'Como interpretar a análise'),
    el('p', '', 'Mínimo, média, máximo e desvio-padrão resumem a distribuição das leituras no período.'),
    el('p', '', 'A tendência é a inclinação de uma reta ajustada à série (regressão linear). Ela descreve o período, não é uma previsão.'),
    el('p', '', 'Faixas coloridas no gráfico (com um parque selecionado) indicam valores de atenção (amarelo) e ruins (vermelho).'),
    el('p', '', 'Para comparar com o período anterior, selecione apenas um parque e um período diferente de "Tudo".')
  ]));

  raiz.append(el('details', 'faq', [
    el('summary', '', 'Sensores e limitações'),
    tabela(['Sensor', 'Mede', 'Faixa / observação'], [
      ['DHT22', 'Temperatura e umidade', '−40 a 80 °C (±0,5 °C); 0 a 100% UR (±2–5%)'],
      ['MG811', 'CO₂', '350 a 10.000 ppm; precisa de aquecimento e calibração'],
      ['MQ-135', 'Mistura de gases', 'Indicador relativo; sensível a temperatura e umidade']
    ]),
    el('p', 'mute small', 'Sensação térmica e ponto de orvalho são calculados a partir da temperatura e da umidade.')
  ]));

  return raiz;
}
