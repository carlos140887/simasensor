// Ponto de entrada: estado global, navegação entre abas e atualização automática.
import * as api from './api.js';
import { API, CORES } from './config.js';
import { enriquecer } from './clima.js';
import { $, el, ha, quando, tip } from './ui.js';
import { telaCidadao } from './views/cidadao.js';
import { telaPesquisa } from './views/pesquisa.js';

const S = {
  aba: 'cidadao',
  parque: null,
  sel: new Set(),
  v: 'temperatura',
  per: 7,
  ant: false
};

const ctx = {
  S,
  parques: [],
  periodo: { ini: null, fim: null, total: 0 },
  nome: id => ctx.parques.find(p => p.id === id)?.nome || id,
  cor: id => CORES[Math.max(0, ctx.parques.findIndex(p => p.id === id)) % CORES.length],
  ultima: id => ctx.parques.find(p => p.id === id)?.ultima || null,
  /** Referência de "agora" para janelas de tempo: a leitura mais recente do banco. */
  get fim() { return ctx.periodo.fim ?? Date.now(); },
  render: () => render()
};

/* ---------------- URL ↔ estado ---------------- */
function lerHash() {
  const [aba, parque] = location.hash.replace(/^#\/?/, '').split('/');
  if (aba === 'pesquisa' || aba === 'cidadao') S.aba = aba;
  if (parque && ctx.parques.some(p => p.id === parque)) S.parque = parque;
}

function gravarHash() {
  const h = S.aba === 'cidadao' && S.parque ? `#cidadao/${S.parque}` : `#${S.aba}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}

/* ---------------- render ---------------- */
let geracao = 0;

async function render() {
  const g = ++geracao;
  const cid = S.aba === 'cidadao';
  const pc = $('#p-cid'), pp = $('#p-pes');
  pc.hidden = !cid;
  pp.hidden = cid;
  for (const [b, ativo] of [[$('#t-cid'), cid], [$('#t-pes'), !cid]]) {
    b.setAttribute('aria-selected', String(ativo));
    b.tabIndex = ativo ? 0 : -1;
  }
  tip(null);
  gravarHash();

  try {
    // descarta o resultado se outro render começou enquanto este esperava a rede
    const conteudo = await (cid ? telaCidadao : telaPesquisa)(ctx);
    if (g !== geracao) return;
    (cid ? pc : pp).replaceChildren(conteudo);
  } catch (e) {
    console.error(e);
    if (g === geracao) (cid ? pc : pp).replaceChildren(el('p', 'empty', 'Não foi possível montar esta tela. Tente recarregar.'));
  }
}

/* ---------------- status ---------------- */
function atualizarStatus(agora) {
  const st = $('#status');
  const { fim, total } = ctx.periodo;
  const modo = api.modoAtual();
  const estado = !fim ? 'erro' : agora - fim > 3 * 3600e3 ? 'antigo' : 'vivo';
  st.dataset.estado = estado;
  const rotulo = modo !== 'api' ? 'Modo demonstração' : estado === 'vivo' ? 'Ao vivo' : 'Sensores sem enviar dados';
  st.replaceChildren(
    el('i', 'pulse'),
    el('span', '', fim
      ? [el('strong', '', rotulo),
         ` · última leitura ${ha(fim, agora)} (${quando(fim)}) · ${total.toLocaleString('pt-BR')} medições`]
      : 'Nenhuma medição disponível.')
  );
}

async function carregar() {
  const r = await api.parques();
  ctx.parques = r.parques.map(p => ({ ...p, ultima: enriquecer(p.ultima) }));
  ctx.periodo = r.periodo;
  if (!S.parque || !ctx.parques.some(p => p.id === S.parque)) S.parque = ctx.parques[0]?.id;
  if (!S.sel.size && S.parque) S.sel.add(S.parque);
  atualizarStatus(r.agora);
}

/* ---------------- inicialização ---------------- */
$('#t-cid').onclick = () => { S.aba = 'cidadao'; render(); };
$('#t-pes').onclick = () => { S.aba = 'pesquisa'; render(); };
$('.tabs').onkeydown = ev => {
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
  ev.preventDefault();
  S.aba = S.aba === 'cidadao' ? 'pesquisa' : 'cidadao';
  render().then(() => (S.aba === 'cidadao' ? $('#t-cid') : $('#t-pes')).focus());
};
addEventListener('hashchange', () => { lerHash(); render(); });


(async () => {
  try {
    await carregar();
    lerHash();
    await render();
  } catch (e) {
    console.error(e);
    $('#status').dataset.estado = 'erro';
    $('#status').textContent = 'Não foi possível carregar as medições.';
    $('#p-cid').replaceChildren(el('p', 'empty', 'Sem conexão com o servidor de dados.'));
  }

  // Atualização automática (só quando a aba do navegador está visível)
  setInterval(async () => {
    if (document.hidden || api.modoAtual() !== 'api') return;
    const fimAntes = ctx.periodo.fim;
    api.limparCache();
    await carregar().catch(() => {});
    if (ctx.periodo.fim !== fimAntes && S.aba === 'cidadao') render();
  }, API.ATUALIZAR_MS);
})();
