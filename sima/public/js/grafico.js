// Gráfico de linhas em SVG, sem bibliotecas.
import { el, fmt, quando, hora, dia, tip } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const DIA = 864e5;

function nice(v) {
  const p = 10 ** Math.floor(Math.log10(v || 1));
  const f = v / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

let uid = 0;

/**
 * series: [{ nome, cor, pts: [{t, v}], tracejada? }]
 * op: { u: unidade, d: casas, h: altura, titulo, xf, tf, faixas: [{de, ate, cls}], area }
 */
export function grafico(host, series, op = {}) {
  if (!series.some(s => s.pts.length)) {
    host.replaceChildren(el('p', 'empty', 'Sem medições neste período.'));
    return;
  }
  // Desenha na largura real do container (texto sempre no tamanho certo)
  // e redesenha quando ela muda (girar o celular, redimensionar a janela).
  let largura = 0;
  const ro = new ResizeObserver(([e]) => {
    if (!host.isConnected) { ro.disconnect(); return; }
    const w = Math.round(e.contentRect.width);
    if (w > 0 && Math.abs(w - largura) > 8) { largura = w; desenhar(host, series, op, w); }
  });
  ro.observe(host);
}

function desenhar(host, series, op, W) {
  host.replaceChildren();
  const todas = series.flatMap(s => s.pts);
  const mobile = W < 520;
  const H = op.h || Math.round(Math.min(300, Math.max(220, W * 0.42)));
  const L = mobile ? 40 : 48, R = 12, TOP = 14, B = 30;
  const casas = op.d ?? 1;

  let x0 = Infinity, x1 = -Infinity, lo = Infinity, hi = -Infinity;
  for (const p of todas) {
    if (p.t < x0) x0 = p.t; if (p.t > x1) x1 = p.t;
    if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v;
  }
  if (x1 === x0) x1 = x0 + 1;
  if (hi === lo) { hi += 1; lo -= 1; }
  const passo = nice((hi - lo) / 4);
  lo = Math.floor(lo / passo) * passo;
  hi = Math.ceil(hi / passo) * passo;

  const fmtX = op.xf || ((x1 - x0) < 2 * DIA ? hora : dia);
  const fmtT = op.tf || quando;
  const X = t => L + ((t - x0) / (x1 - x0)) * (W - L - R);
  const Y = v => H - B - ((v - lo) / (hi - lo)) * (H - B - TOP);

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'ch');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${op.titulo || 'Gráfico'}: ${series.map(s => s.nome).join(', ')}`);

  const add = (tag, attrs, pai = svg) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    pai.append(e);
    return e;
  };

  // Faixas de referência (atenção/ruim) ao fundo
  for (const f of op.faixas || []) {
    const a = Math.max(lo, f.de ?? lo), b = Math.min(hi, f.ate ?? hi);
    if (b > a) add('rect', { x: L, width: W - L - R, y: Y(b), height: Y(a) - Y(b), class: 'band ' + f.cls });
  }

  for (let v = lo; v <= hi + 1e-9; v += passo) {
    add('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'gr' });
    add('text', { x: L - 8, y: Y(v) + 4, class: 'ax', 'text-anchor': 'end' }).textContent = fmt(v, passo < 1 ? 1 : 0);
  }

  const marcas = Math.max(2, Math.min(6, Math.floor(W / 120)));
  for (let i = 0; i <= marcas; i++) {
    const t = x0 + ((x1 - x0) * i) / marcas;
    add('text', {
      x: X(t), y: H - 8, class: 'ax',
      'text-anchor': i === 0 ? 'start' : i === marcas ? 'end' : 'middle'
    }).textContent = fmtX(t);
  }

  const defs = add('defs', {});
  for (const s of series) {
    if (!s.pts.length) continue;
    // quebra a linha quando falta dado (intervalo > 3x o passo típico)
    const gaps = s.pts.slice(1).map((p, i) => p.t - s.pts[i].t).sort((a, b) => a - b);
    const tipico = gaps[Math.floor(gaps.length / 2)] || Infinity;
    let d = '';
    s.pts.forEach((p, i) => {
      const quebra = i === 0 || p.t - s.pts[i - 1].t > tipico * 3;
      d += `${quebra ? 'M' : 'L'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`;
    });

    if (op.area !== false && series.length === 1 && s.pts.length > 1) {
      const id = 'g' + ++uid;
      const g = add('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      add('stop', { offset: '0%', 'stop-color': s.cor, 'stop-opacity': .22 }, g);
      add('stop', { offset: '100%', 'stop-color': s.cor, 'stop-opacity': 0 }, g);
      const base = Y(lo).toFixed(1);
      const area = d.replace(/M([\d.]+),([\d.]+)/g, (m, x, y) => `M${x},${base}L${x},${y}`) +
        `L${X(s.pts.at(-1).t).toFixed(1)},${base}Z`;
      add('path', { d: area, fill: `url(#${id})`, stroke: 'none' });
    }

    add('path', { d, class: 'ln', stroke: s.cor, 'stroke-dasharray': s.tracejada ? '6 5' : 'none' });
    if (s.pts.length <= W / 12) {
      for (const p of s.pts) add('circle', { cx: X(p.t), cy: Y(p.v), r: 3, fill: s.cor, class: 'pt' });
    }
  }

  const cursor = add('line', { y1: TOP, y2: H - B, class: 'cur', visibility: 'hidden' });
  const marcadores = series.map(s => add('circle', { r: 5, fill: s.cor, class: 'mk', visibility: 'hidden' }));

  function apontar(ev) {
    const r = svg.getBoundingClientRect();
    const t = x0 + ((((ev.clientX - r.left) / r.width) * W - L) / (W - L - R)) * (x1 - x0);
    const linhas = [];
    let tRef = null;
    series.forEach((s, i) => {
      let melhor = null;
      for (const p of s.pts) if (!melhor || Math.abs(p.t - t) < Math.abs(melhor.t - t)) melhor = p;
      if (!melhor) return;
      tRef ??= melhor.t;
      marcadores[i].setAttribute('cx', X(melhor.t));
      marcadores[i].setAttribute('cy', Y(melhor.v));
      marcadores[i].setAttribute('visibility', 'visible');
      linhas.push([s.cor, series.length > 1 ? s.nome : '', `${fmt(melhor.v, casas)} ${op.u || ''}`]);
    });
    if (tRef == null) return;
    cursor.setAttribute('x1', X(tRef));
    cursor.setAttribute('x2', X(tRef));
    cursor.setAttribute('visibility', 'visible');
    tip(ev, fmtT(tRef), linhas);
  }

  svg.addEventListener('pointermove', apontar);
  svg.addEventListener('pointerdown', apontar);
  svg.addEventListener('pointerleave', () => {
    cursor.setAttribute('visibility', 'hidden');
    marcadores.forEach(m => m.setAttribute('visibility', 'hidden'));
    tip(null);
  });

  host.append(svg);

  if (series.length > 1) {
    host.append(el('div', 'leg', series.map(s => {
      const p = el('i', 'dot' + (s.tracejada ? ' dash' : ''));
      p.style.background = s.cor;
      return el('span', '', [p, s.nome]);
    })));
  }
}

/** Mini gráfico sem eixos para os cartões. */
export function sparkline(pts, cor) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 28');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('aria-hidden', 'true');
  if (pts.length < 2) return svg;
  const vs = pts.map(p => p.v);
  const lo = Math.min(...vs), hi = Math.max(...vs) || lo + 1;
  const t0 = pts[0].t, t1 = pts.at(-1).t;
  const d = pts.map((p, i) =>
    `${i ? 'L' : 'M'}${(((p.t - t0) / (t1 - t0 || 1)) * 100).toFixed(1)},${(26 - ((p.v - lo) / (hi - lo || 1)) * 24).toFixed(1)}`
  ).join('');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('stroke', cor);
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(path);
  return svg;
}
