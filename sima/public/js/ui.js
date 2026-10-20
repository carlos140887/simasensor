// Utilitários de interface: criação de elementos, formatação, tooltip.
import { num } from './clima.js';

export const $ = s => document.querySelector(s);

/** Cria elemento. filhos pode ser texto, nó ou lista dos dois. */
export function el(tag, cls, filhos) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (filhos != null) e.append(...[].concat(filhos).filter(x => x != null && x !== false));
  return e;
}

export const fmt = (v, casas = 1) => num(v)
  ? v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })
  : '—';

export const quando = ts => new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
export const dia = ts => new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
export const hora = ts => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** "há 5 min", "há 3 h", "há 2 dias" */
export function ha(ts, agora = Date.now()) {
  const s = Math.max(0, (agora - ts) / 1000);
  if (s < 60) return 'agora mesmo';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return `há ${d} dia${d > 1 ? 's' : ''}`;
}

/* ---------------- tooltip ---------------- */
export function tip(evento, titulo, linhas) {
  const tt = $('#tip');
  if (!tt) return;
  if (!linhas) { tt.hidden = true; return; }

  tt.replaceChildren(el('b', '', titulo));
  for (const [cor, nome, valor] of linhas) {
    const ponto = el('i', 'dot');
    ponto.style.background = cor;
    tt.append(el('div', '', [ponto, el('span', '', nome ? `${nome}: ` : ''), el('strong', '', valor)]));
  }
  tt.hidden = false;
  if (!evento) return;

  const w = tt.offsetWidth, h = tt.offsetHeight;
  let x = evento.clientX + 14;
  let y = evento.clientY - h - 12;
  if (x + w > innerWidth - 8) x = evento.clientX - w - 14;
  if (x < 8) x = 8;
  if (y < 8) y = evento.clientY + 18;
  tt.style.transform = `translate(${x}px, ${y}px)`;
}

/* ---------------- componentes simples ---------------- */
export function painel(titulo, conteudo, extra) {
  const p = el('section', 'panel');
  if (titulo) p.append(el('header', 'panel-head', [el('h3', '', titulo), extra]));
  p.append(conteudo);
  return p;
}

export function secao(titulo, sub) {
  return el('div', 'sec-head', [el('h2', '', titulo), sub && el('p', 'mute', sub)]);
}

export function selectCampo(rotulo, opcoes, valor, aoMudar) {
  const s = el('select');
  for (const [v, n] of opcoes) {
    const o = el('option', '', n);
    o.value = v;
    o.selected = String(v) === String(valor);
    s.append(o);
  }
  s.onchange = () => aoMudar(s.value);
  return el('label', 'field', [el('span', '', rotulo), s]);
}

export function segmentado(rotulo, opcoes, valor, aoMudar) {
  const g = el('div', 'seg');
  g.setAttribute('role', 'radiogroup');
  g.setAttribute('aria-label', rotulo);
  for (const [v, n] of opcoes) {
    const b = el('button', '', n);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(String(v) === String(valor)));
    b.onclick = () => {
      for (const x of g.children) x.setAttribute('aria-checked', String(x === b));
      aoMudar(v);
    };
    g.append(b);
  }
  return el('div', 'field', [el('span', '', rotulo), g]);
}

export function vazio(txt) {
  return el('p', 'empty', txt);
}

export function esqueleto(n = 3, cls = 'sk-card') {
  return el('div', 'grid', Array.from({ length: n }, () => el('div', 'sk ' + cls)));
}
