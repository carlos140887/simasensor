(() => {
  'use strict';

  /* ============================================================
     CONFIGURAÇÃO
     ============================================================ */
  const CFG = {
    API_URL: '',
    ARQUIVO: 'medicoes.json?v=2026-10-15-1',

    // ===== Medições ao vivo do ESP32 (Netlify Function deste mesmo site) =====
    API_VIVO: '/api/medicoes',
    DIAS_VIVO: 120,              // quantos dias buscar do banco
    ATUALIZAR_MS: 120000,        // atualiza a página sozinha a cada 2 min

    PARQUES: [
      { id: 'dois-irmaos', nome: 'Parque Dois Irmãos' },
      { id: 'macaxeira', nome: 'Parque da Macaxeira' },
      { id: 'tamarineira', nome: 'Parque da Tamarineira' },
      { id: 'jardim-poco', nome: 'Jardim do Poço' },
      { id: 'jaqueira', nome: 'Parque da Jaqueira' },
      { id: 'governador-eduardo-campos', nome: 'Parque Gov. Eduardo Campos' }
    ],

    CORES: ['#0f7ea3', '#d8503f', '#e59a0c', '#2e9d5b', '#8a4fa0', '#5b6b73'],

    // Limites orientativos (fundo natural / atenção / alerta)
    LIM: {
      co2eq: [650, 650]          // CO2 estimado (MQ-135): até 650 bom, acima alerta
    },

    // Cache TTL em ms para séries (evita recomputação em re-renders)
    CACHE_TTL: 5000
  };

  const V = {
    temperatura: ['Temperatura', '°C', 1],
    umidade: ['Umidade relativa', '%', 0],
    co2eq: ['CO₂ estimado (MQ-135)', 'ppm', 0],
    sensacao: ['Sensação térmica', '°C', 1],
    orvalho: ['Ponto de orvalho', '°C', 1]
  };

  const PER = [['24 h', 1], ['7 dias', 7], ['30 dias', 30], ['Tudo', 0]];
  const DAY = 864e5;

  /* ============================================================
     ESTADO
     ============================================================ */
  const S = {
    aba: 'cid',
    park: CFG.PARQUES[0].id,
    sel: new Set([CFG.PARQUES[0].id]),
    v: 'temperatura',
    per: 7,
    ant: false
  };

  let D = [];
  let FIM = Date.now();
  const cache = new Map();

  /* ============================================================
     UTILITÁRIOS
     ============================================================ */
  const $ = s => document.querySelector(s);
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  const fmt = (v, c = 1) => num(v)
    ? v.toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c })
    : '—';

  const T = m => +new Date(m.data_hora);

  const quando = ts => new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const dia = ts => new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const hora = ts => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  const idx = id => CFG.PARQUES.findIndex(p => p.id === id);
  const nome = id => CFG.PARQUES.find(p => p.id === id)?.nome || id;
  const cor = id => CFG.CORES[Math.max(0, idx(id)) % CFG.CORES.length];

  const med = arr => arr.length ? arr.reduce((s, x) => s + (x.v ?? x), 0) / arr.length : NaN;

  function nice(v) {
    const p = 10 ** Math.floor(Math.log10(v || 1));
    const f = v / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }

  /* ============================================================
     CÁLCULOS METEOROLÓGICOS
     ============================================================ */
  function sensacao(t, u) {
    const f = t * 1.8 + 32;
    if (f < 80) return t;
    const h =
      -42.379 + 2.04901523 * f + 10.14333127 * u -
      0.22475541 * f * u - 0.00683783 * f * f -
      0.05481717 * u * u + 0.00122874 * f * f * u +
      0.00085282 * f * u * u - 0.00000199 * f * f * u * u;
    return (h - 32) / 1.8;
  }

  function orvalho(t, u) {
    if (u <= 0) return NaN;
    const g = Math.log(u / 100) + (17.62 * t) / (243.12 + t);
    return (243.12 * g) / (17.62 - g);
  }

  function enriquecer(m) {
    const out = { ...m };
    if (num(m.temperatura) && num(m.umidade)) {
      out.sensacao = sensacao(m.temperatura, m.umidade);
      out.orvalho = orvalho(m.temperatura, m.umidade);
    }
    return out;
  }

  /* ============================================================
     SÉRIES (com cache)
     ============================================================ */
  function serie(id, var_, dias, desloc = 0) {
    const key = `${id}|${var_}|${dias}|${desloc}|${FIM}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.t < CFG.CACHE_TTL) return cached.v;

    const fim = FIM - desloc;
    const ini = dias ? fim - dias * DAY : -Infinity;
    const out = D
      .filter(m => m.parque === id && num(m[var_]) && T(m) > ini && T(m) <= fim)
      .map(m => ({ t: T(m) + desloc, v: m[var_] }))
      .sort((a, b) => a.t - b.t);

    cache.set(key, { v: out, t: Date.now() });
    return out;
  }

  function ultima(id) {
    let r = null;
    for (const m of D) {
      if (m.parque === id && (!r || T(m) > T(r))) r = m;
    }
    return r;
  }

  function perfil(id, var_, dias) {
    const grupos = Array.from({ length: 24 }, () => []);
    const ini = dias ? FIM - dias * DAY : -Infinity;

    for (const m of D) {
      if (m.parque === id && num(m[var_]) && T(m) > ini) {
        grupos[new Date(m.data_hora).getHours()].push({ v: m[var_] });
      }
    }
    return grupos
      .map((g, h) => ({ t: h, v: med(g) }))
      .filter(p => num(p.v));
  }

  function est(pontos) {
    const n = pontos.length;
    if (!n) return null;

    const vals = pontos.map(p => p.v);
    const media = med(pontos);
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - media) ** 2, 0) / n);

    let tr = NaN;
    if (n > 2) {
      const mt = pontos.reduce((s, p) => s + p.t, 0) / n;
      let a = 0, b = 0;
      for (const p of pontos) {
        a += (p.t - mt) * (p.v - media);
        b += (p.t - mt) ** 2;
      }
      tr = b ? (a / b) * DAY : NaN;
    }

    return {
      n,
      min: Math.min(...vals),
      max: Math.max(...vals),
      m: media,
      sd,
      last: vals[vals.length - 1],
      tr
    };
  }

  /* ============================================================
     CLASSIFICAÇÕES
     ============================================================ */
  const nv = (v, [a, b]) => v <= a ? 0 : v <= b ? 1 : 2;

  const wCalor = s =>
    s < 15 ? 'Muito frio' : s < 18 ? 'Frio' : s < 27 ? 'Agradável' :
    s < 30 ? 'Quente' : s < 34 ? 'Muito quente' : 'Calor elevado';

  const wUmid = u =>
    u < 30 ? 'Muito seco' : u < 40 ? 'Ar seco' : u <= 60 ? 'Equilibrada' :
    u <= 70 ? 'Alta' : u <= 85 ? 'Muito alta' : 'Extremamente úmida';

  function situacao(m) {
    if (!m) return { n: 'd', t: 'Sem medição', x: 'Ainda não recebemos leituras deste parque.' };

    const niveis = [];
    const motivos = [];
    let calor = false, ar = false;

    const vc = num(m.temperatura) ? m.temperatura : (num(m.sensacao) ? m.sensacao : null);
    if (num(vc)) {
      calor = true;
      const n = vc < 15 || vc > 30 ? 2 : vc < 18 || vc > 27 ? 1 : 0;
      niveis.push(n);
      if (n) motivos.push(`Temperatura de ${fmt(vc, 0)} °C`);
    }

    if (num(m.umidade)) {
      const n = m.umidade < 30 || m.umidade > 85 ? 2 : m.umidade < 40 || m.umidade > 70 ? 1 : 0;
      niveis.push(n);
      if (n) motivos.push(`Umidade relativa de ${fmt(m.umidade, 0)}%, fora da faixa recomendada`);
    }

    for (const k of ['co2eq']) {
      if (num(m[k]) && CFG.LIM[k]) {
        ar = true;
        const n = nv(m[k], CFG.LIM[k]);
        niveis.push(n);
        if (n) motivos.push(V[k][0] + (n === 1 ? ' um pouco alto' : ' muito alto'));
      }
    }

    if (!niveis.length) {
      return { n: 'd', t: 'Dados insuficientes', x: 'Faltam dados suficientes para gerar uma avaliação.' };
    }

    const n = Math.max(...niveis);
    const explic = [
      'Clima e ar dentro dos parâmetros definidos pelo sistema.',
      'Alguns indicadores ambientais merecem atenção.',
      'Os indicadores ambientais estão ruins e exigem cuidado imediato.'
    ];

    return {
      n,
      t: ['Condições favoráveis', 'Atenção', 'Ruim'][n],
      x: (motivos.length ? motivos.join('; ') + '. ' : '') + explic[n] +
         (calor && ar ? '' : ' Avaliação parcial devido à ausência de alguns indicadores.')
    };
  }

  function nivelMetric(metric, m) {
    if (!m) return 0;
    switch (metric) {
      case 'temperatura':
      case 'sensacao': {
        const v = metric === 'sensacao' ? m.sensacao : m.temperatura;
        return v < 15 || v > 30 ? 2 : v < 18 || v > 27 ? 1 : 0;
      }
      case 'umidade':
        return m.umidade < 30 || m.umidade > 85 ? 2 : m.umidade < 40 || m.umidade > 70 ? 1 : 0;
      case 'co2eq':
        return num(m.co2eq) ? nv(m.co2eq, CFG.LIM.co2eq) : 0;
      default:
        return 0;
    }
  }

  /* ============================================================
     TOOLTIP
     ============================================================ */
  const NS = 'http://www.w3.org/2000/svg';

  function tip(evento, titulo, linhas) {
    const tt = $('#tip');
    if (!tt) return;

    if (!linhas) { tt.hidden = true; return; }

    tt.replaceChildren(el('b', '', titulo));
    for (const [c, n, v] of linhas) {
      const linha = el('div');
      const ponto = el('i', 'dot');
      ponto.style.background = c;
      linha.append(ponto, el('span', '', n ? `${n}: ${v}` : v));
      tt.append(linha);
    }
    tt.hidden = false;

    if (!evento) return;

    const w = tt.offsetWidth, h = tt.offsetHeight;
    let x = evento.clientX + 14;
    let y = evento.clientY - h - 10;
    if (x + w > window.innerWidth - 8) x = evento.clientX - w - 14;
    if (x < 8) x = 8;
    if (y < 8) y = evento.clientY + 18;
    tt.style.left = `${x}px`;
    tt.style.top = `${y}px`;
  }

  /* ============================================================
     GRÁFICO SVG
     ============================================================ */
  function chart(host, series, opcoes = {}) {
    host.replaceChildren();

    const todas = series.flatMap(s => s.pts);
    if (!todas.length) {
      host.append(el('p', 'mute', 'Sem medições neste período.'));
      return;
    }

    const W = 680;
    const mobile = (host.clientWidth || window.innerWidth) < 520;
    const H = opcoes.h || (mobile ? 240 : 280);
    const L = mobile ? 44 : 52;
    const R = 16, TOP = 18, B = mobile ? 36 : 34;
    const casas = opcoes.d ?? 1;

    let x0 = Math.min(...todas.map(p => p.t));
    let x1 = Math.max(...todas.map(p => p.t));
    let lo = Math.min(...todas.map(p => p.v));
    let hi = Math.max(...todas.map(p => p.v));

    if (x1 === x0) x1 = x0 + 1;
    if (hi === lo) { hi += 1; lo -= 1; }

    const passo = nice((hi - lo) / 4);
    lo = Math.floor(lo / passo) * passo;
    hi = Math.ceil(hi / passo) * passo;

    const fmtX = opcoes.xf || ((x1 - x0) < 2 * DAY ? hora : dia);
    const fmtTT = opcoes.tf || quando;

    const X = t => L + ((t - x0) / (x1 - x0)) * (W - L - R);
    const Y = v => H - B - ((v - lo) / (hi - lo)) * (H - B - TOP);

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'ch');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${opcoes.t || 'Gráfico'}, ${series.map(s => s.nome).join(', ')}`);

    const add = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      svg.append(e);
      return e;
    };

    // Grid horizontal + labels Y
    for (let v = lo; v <= hi + 1e-9; v += passo) {
      add('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'gr' });
      const txt = add('text', { x: L - 8, y: Y(v) + 4, class: 'ax', 'text-anchor': 'end' });
      txt.textContent = fmt(v, casas);
    }

    // Labels X
    const marks = mobile ? 2 : 4;
    for (let i = 0; i <= marks; i++) {
      const t = x0 + ((x1 - x0) * i) / marks;
      const txt = add('text', {
        x: X(t), y: H - 10, class: 'ax',
        'text-anchor': i === 0 ? 'start' : i === marks ? 'end' : 'middle'
      });
      txt.textContent = fmtX(t);
    }

    // Linhas + pontos
    for (const s of series) {
      if (s.pts.length > 1) {
        add('polyline', {
          points: s.pts.map(p => `${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' '),
          class: 'ln',
          stroke: s.cor,
          'stroke-dasharray': s.tr ? '6 5' : 'none'
        });
      }
      const lim = mobile ? 35 : 70;
      if (s.pts.length <= lim) {
        s.pts.forEach(p => add('circle', {
          cx: X(p.t), cy: Y(p.v), r: mobile ? 3.2 : 2.8, fill: s.cor
        }));
      }
    }

    // Cursor + interação
    const cursor = add('line', { y1: TOP, y2: H - B, class: 'cur', visibility: 'hidden' });

    function apontar(ev) {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const t = x0 + ((px - L) / (W - L - R)) * (x1 - x0);

      const linhas = [];
      let tEscolhido = null;

      for (const s of series) {
        let melhor = null;
        for (const p of s.pts) {
          if (!melhor || Math.abs(p.t - t) < Math.abs(melhor.t - t)) melhor = p;
        }
        if (melhor) {
          linhas.push([s.cor, s.nome, `${fmt(melhor.v, casas)} ${opcoes.u || ''}`]);
          if (tEscolhido == null) tEscolhido = melhor.t;
        }
      }

      if (tEscolhido == null) return;
      cursor.setAttribute('x1', X(tEscolhido));
      cursor.setAttribute('x2', X(tEscolhido));
      cursor.setAttribute('visibility', 'visible');
      tip(ev, fmtTT(tEscolhido), linhas);
    }

    svg.addEventListener('pointermove', apontar);
    svg.addEventListener('pointerdown', apontar);
    svg.addEventListener('pointerleave', () => {
      cursor.setAttribute('visibility', 'hidden');
      tip(null, '', null);
    });

    host.append(svg);

    // Legenda
    if (series.length > 1) {
      const leg = el('div', 'leg');
      for (const s of series) {
        const item = el('span');
        const p = el('i', 'dot');
        p.style.background = s.cor;
        item.append(p, s.nome + (s.tr ? ' (período anterior)' : ''));
        leg.append(item);
      }
      host.append(leg);
    }
  }

  /* ============================================================
     COMPONENTES
     ============================================================ */
  const box = (titulo, fn, opcoes) => {
    const p = el('div', 'panel');
    if (titulo) p.append(el('h3', '', titulo));
    const h = el('div');
    p.append(h);
    fn(h, opcoes);
    return p;
  };

  function chips(multiplo) {
    const lista = el('ul', 'chips');
    for (const p of CFG.PARQUES) {
      const li = el('li');
      const btn = el('button');
      const dot = el('i', 'dot');
      dot.style.background = cor(p.id);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', multiplo ? S.sel.has(p.id) : S.park === p.id);
      btn.append(dot, p.nome);
      btn.onclick = () => {
        if (multiplo) {
          if (S.sel.has(p.id)) { if (S.sel.size > 1) S.sel.delete(p.id); }
          else S.sel.add(p.id);
        } else {
          S.park = p.id;
        }
        cache.clear();
        render();
      };
      li.append(btn);
      lista.append(li);
    }
    return lista;
  }

  function sitBox(m) {
    const s = situacao(m);
    const b = el('div', 'sit n' + s.n);
    b.append(el('span', 'ico', { 0: '✓', 1: '!', 2: '×', d: '?' }[s.n] || '?'));
    const txt = el('div');
    let desc = s.x;
    if (m && Date.now() - T(m) > 108e5) desc += ' A última leitura disponível tem mais de 3 horas.';
    txt.append(el('b', '', s.t), el('p', 'mute', desc));
    b.append(txt);
    return b;
  }

  function card(rotulo, valor, desc) {
    const c = el('div', 'card');
    c.append(el('div', 'l', rotulo), el('div', 'v', valor));
    if (desc) c.append(el('div', 'w', desc));
    return c;
  }

  /* ============================================================
     ABA CIDADÃO
     ============================================================ */
  function cidadao() {
    const painel = $('#p-cid');
    if (!painel) return;
    painel.replaceChildren();

    const id = S.park;
    const m = ultima(id);

    painel.append(el('h3', '', 'Escolha um parque'), chips(false));

    // Hero
    const hero = el('div', 'hero');
    hero.append(el('div', 'big', num(m?.temperatura) ? fmt(m.temperatura, 0) + '°' : '—'));

    const th = el('div');
    th.append(el('h2', '', nome(id)));
    if (m) {
      let txt = '';
      if (num(m.sensacao)) txt += `Sensação de ${fmt(m.sensacao, 0)}°, ${wCalor(m.sensacao).toLowerCase()}. `;
      txt += `Atualizado em ${quando(T(m))}.`;
      th.append(el('p', '', txt));
    } else {
      th.append(el('p', '', 'Nenhuma medição recebida deste parque ainda.'));
    }
    hero.append(th);
    painel.append(hero, sitBox(m));

    // Cards
    const grade = el('div', 'grid');
    grade.append(
      card('Umidade do ar', num(m?.umidade) ? fmt(m.umidade, 0) + '%' : '—', num(m?.umidade) ? wUmid(m.umidade) : 'Sem medição'),
      card('CO₂ estimado (MQ-135)', num(m?.co2eq) ? fmt(m.co2eq, 0) + ' ppm' : '—',
        num(m?.co2eq) ? (m.co2eq > CFG.LIM.co2eq[1] ? 'Alerta: acima de 650 ppm' : 'Bom: até 650 ppm') + ' (estimativa)' : 'Sem medição')
    );

    if (num(m?.orvalho)) {
      grade.append(card('Ponto de orvalho', fmt(m.orvalho, 1) + ' °C', 'Calculado pela temperatura e umidade'));
    }

    const atual = serie(id, 'temperatura', 1);
    const ant = serie(id, 'temperatura', 1, DAY);
    const mA = med(atual), mB = med(ant);

    grade.append(card(
      'Hoje comparado a ontem',
      num(mA) && num(mB) ? (mA >= mB ? '+' : '−') + fmt(Math.abs(mA - mB), 1) + ' °C' : '—',
      num(mA) && num(mB) ? 'Média das últimas 24 h vs. 24 h anteriores' : 'São necessários pelo menos 2 dias de medições'
    ));

    painel.append(el('h3', '', 'Como o ambiente está'), grade);

    // Últimas 24h
    painel.append(el('h3', '', 'Últimas 24 horas'));
    const dois = el('div', 'two');
    for (const k of ['temperatura', 'umidade']) {
      dois.append(box(V[k][0], host => chart(host, [{
        nome: V[k][0], cor: cor(id), pts: serie(id, k, 1)
      }], { u: V[k][1], d: V[k][2], t: V[k][0] })));
    }
    painel.append(dois);

    // Todos os parques
    painel.append(el('h3', '', 'Todos os parques agora'));
    const todos = el('div', 'grid');
    for (const p of CFG.PARQUES) {
      const mm = ultima(p.id);
      const s = situacao(mm);
      const btn = el('button', 'card pk n' + s.n);
      btn.type = 'button';
      const ic = { 0: '✓ ', 1: '! ', 2: '× ', d: '' }[s.n];
      btn.append(
        el('div', 'l', p.nome),
        el('div', 'v', num(mm?.temperatura) ? fmt(mm.temperatura, 0) + '°' : '—'),
        el('div', 'w', ic + s.t)
      );
      btn.onclick = () => {
        S.park = p.id;
        cache.clear();
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
      todos.append(btn);
    }
    painel.append(todos);

    // Guia cidadão
    const parqueAtual = ultima(S.park);
    const estadoAtual = situacao(parqueAtual);

    painel.append(el('h3', '', 'O que esses dados significam para você?'));
    const guia = el('div', 'citizen-guide');
    const itensGuia = {
      0: [
        ['🌡️', 'Clima confortável', 'A temperatura e a sensação térmica ficam compatíveis com um ambiente mais agradável para a maioria das pessoas.'],
        ['💧', 'Umidade equilibrada', 'A umidade está em faixa que tende a aliviar a sensação de calor e manter o ar mais confortável.'],
        ['🌬️', 'Ar em bom nível', 'O CO₂ estimado pelo MQ-135 está até 650 ppm, sem sinal de ar carregado.'],
        ['🧪', 'Indicadores estáveis', 'Os gases monitorados permanecem dentro de uma faixa mais estável, sem indicar pressão ambiental forte.']
      ],
      1: [
        ['🌡️', 'Calor com atenção', 'A sensação térmica indica que o ambiente deve ser observado com mais cuidado, principalmente em horas mais quentes.'],
        ['💧', 'Umidade merece cuidado', 'A umidade alta pode deixar a sensação térmica mais cansativa e aumentar o desconforto.'],
        ['🌬️', 'CO₂ mais elevado', 'O CO₂ estimado subiu em relação ao ar de calibração (350 ppm), sugerindo ar mais carregado.'],
        ['🧪', 'Variações do ar', 'Mudanças nos gases monitorados podem sinalizar maior pressão do ambiente, mesmo sem valores extremos.']
      ],
      2: [
        ['🌡️', 'Calor elevado', 'A sensação térmica está alta e pode exigir atenção, especialmente para quem passa muito tempo ao ar livre.'],
        ['💧', 'Umidade muito alta', 'A combinação com a umidade pode tornar o ambiente mais pesado e desconfortável.'],
        ['🌬️', 'Ar mais crítico', 'O CO₂ estimado passou de 650 ppm: o ar está mais carregado de gases que no momento da calibração.'],
        ['🧪', 'Indicadores em alerta', 'O monitoramento aponta que os gases podem estar fora da faixa mais confortável para o uso do espaço.']
      ],
      d: [
        ['📡', 'Dados ainda insuficientes', 'Ainda não temos leitura suficiente para avaliar o nível do ambiente com segurança.'],
        ['💧', 'Monitoramento em andamento', 'A qualidade da leitura pode mudar conforme novos dados forem chegando ao sistema.'],
        ['🌬️', 'Aguardar mais pontos', 'É importante comparar com séries mais longas antes de interpretar o cenário completo.'],
        ['🧪', 'Verificação contínua', 'O sistema continua acompanhando a variação para confirmar se os indicadores se estabilizam.']
      ]
    };

    for (const [ic, tit, txt] of itensGuia[estadoAtual.n] || itensGuia.d) {
      const item = el('article', 'guide-card status-' + (estadoAtual.n === 'd' ? 'd' : estadoAtual.n));
      item.append(el('span', 'guide-icon', ic), el('h4', '', tit), el('p', 'mute', txt));
      guia.append(item);
    }
    painel.append(guia);

    // Comparação rápida
    painel.append(el('h3', '', 'Comparação rápida · últimas 24 horas'));
    painel.append(el('p', 'mute', 'Médias das medições recentes para facilitar a comparação entre os parques monitorados.'));

    const compareDef = {
      sensacao: { label: 'Sensação térmica', casas: 1, format: v => fmt(v, 1) + ' °C' },
      umidade: { label: 'Umidade', casas: 0, format: v => fmt(v, 0) + '%' },
      co2eq: { label: 'CO₂ estimado', casas: 0, format: v => fmt(v, 0) + ' ppm' }
    };

    const toolbar = el('div', 'compare-toolbar');
    let compareMetric = 'sensacao';

    const comp = el('div', 'compare-simple');

    function renderCompare() {
      comp.innerHTML = '';
      const meta = compareDef[compareMetric];
      const lista = CFG.PARQUES.map(p => {
        const pts = serie(p.id, compareMetric, 1);
        const st = est(pts);
        return { parque: p, valor: st ? st.m : null, estat: st };
      }).filter(x => num(x.valor));

      if (!lista.length) {
        comp.append(el('p', 'empty-state', 'Nenhuma medição disponível para comparação no momento.'));
        return;
      }

      const media = med(lista.map(x => ({ v: x.valor })));
      const ranking = [...lista].sort((a, b) => b.valor - a.valor);

      ranking.forEach((item, i) => {
        const nivel = nivelMetric(compareMetric, ultima(item.parque.id));
        const cls = nivel === 2 ? 'is-hot' : nivel === 1 ? 'is-mid' : 'is-cool';
        const c = el('article', 'compare-card ' + cls);

        const top = el('div', 'compare-top');
        top.append(
          el('span', 'compare-badge', nivel === 2 ? 'Ruim' : nivel === 1 ? 'Atenção' : 'Bom'),
          el('span', 'compare-rank', '#' + (i + 1))
        );
        c.append(top, el('h4', '', item.parque.nome));

        const main = el('div', 'compare-main');
        main.append(el('strong', 'compare-value', meta.format(item.valor)));
        if (num(media)) {
          const d = item.valor - media;
          const rel = d > 0 ? 'acima' : d < 0 ? 'abaixo' : 'na média';
          main.append(el('span', 'compare-delta', `${rel} da média geral`));
        }
        c.append(main);

        const det = el('div', 'compare-values');
        det.append(
          el('span', '', '📊 ' + (item.estat ? 'média de ' + meta.format(item.estat.m) : 'sem dados')),
          el('span', '', '⏱️ ' + (item.estat ? 'última leitura ' + meta.format(item.estat.last) : '—'))
        );
        c.append(det);
        comp.append(c);
      });
    }

    const btns = Object.entries(compareDef).map(([k, m]) => {
      const b = el('button', 'compare-pill', m.label);
      b.type = 'button';
      b.addEventListener('click', () => {
        btns.forEach(x => x.classList.toggle('active', x === b));
        compareMetric = k;
        renderCompare();
      });
      return b;
    });
    btns.forEach(b => toolbar.append(b));
    btns[0]?.classList.add('active');
    renderCompare();

    painel.append(toolbar, comp);

    // Detalhes
    const det = el('details');
    det.append(el('summary', '', 'Entenda os indicadores'));
    for (const t of [
      'Sensação térmica: estimativa de como a combinação entre temperatura e umidade pode ser percebida pelo corpo.',
      'CO₂ estimado (MQ-135): ao ligar, o sensor se calibra no ar do local (350 ppm); depois, o valor sobe quando o ar fica mais carregado de gases. Até 650 ppm é considerado bom; acima, alerta. É uma estimativa, não uma medição direta de CO₂.',
      'MQ-135: sensor que reage a diferentes gases. Sem calibração específica, seus valores devem ser interpretados principalmente como variação relativa.',
      'Ponto de orvalho: temperatura na qual o vapor de água presente no ar começaria a se condensar.',
      'As medições apresentadas pelo SIMA são produzidas por sensores de baixo custo e devem ser interpretadas como indicadores ambientais.'
    ]) det.append(el('p', '', t));
    painel.append(det);
  }

  /* ============================================================
     ABA PESQUISA
     ============================================================ */
  function csv() {
    const vars = Object.keys(V);
    const ini = S.per ? FIM - S.per * DAY : -Infinity;
    const linhas = [['parque', 'data_hora', ...vars].join(',')];

    for (const m of D) {
      if (S.sel.has(m.parque) && T(m) > ini) {
        linhas.push([m.parque, m.data_hora, ...vars.map(k => num(m[k]) ? m[k] : '')].join(','));
      }
    }

    const blob = new Blob(['\uFEFF' + linhas.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = 'sima-medicoes.csv';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function sel(rotulo, opcoes, valor, fn) {
    const label = el('label', '', rotulo);
    const s = el('select');
    for (const [v, n] of opcoes) {
      const o = el('option', '', n);
      o.value = v;
      if (String(v) === String(valor)) o.selected = true;
      s.append(o);
    }
    s.onchange = () => fn(s.value);
    label.append(s);
    return label;
  }

  function pesquisa() {
    const painel = $('#p-pes');
    if (!painel) return;
    painel.replaceChildren();

    const ids = [...S.sel];
    const k = S.v;
    const [nomeVar, unidade, casas] = V[k];
    const unico = ids.length === 1 && S.per > 0;

    painel.append(
      el('h2', '', 'Análise comparativa'),
      el('p', 'mute', 'Compare indicadores ambientais entre os parques e diferentes períodos.'),
      el('h3', '', 'Parques'),
      chips(true)
    );

    const ctl = el('div', 'ctl');
    ctl.append(
      sel('Variável', Object.entries(V).map(([c, v]) => [c, `${v[0]} (${v[1]})`]), k, v => { S.v = v; cache.clear(); render(); }),
      sel('Período', PER.map(([n, v]) => [v, n]), S.per, v => { S.per = Number(v); cache.clear(); render(); })
    );

    const lblAnt = el('label');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = S.ant && unico;
    cb.disabled = !unico;
    cb.onchange = () => { S.ant = cb.checked; cache.clear(); render(); };
    lblAnt.append(cb, 'Comparar com período anterior');
    ctl.append(lblAnt);

    const btnCSV = el('button', 'btn', 'Baixar CSV');
    btnCSV.type = 'button';
    btnCSV.onclick = csv;
    ctl.append(btnCSV);
    painel.append(ctl);

    // Gráficos
    const dois = el('div', 'two');
    dois.append(box(nomeVar + ' ao longo do tempo', host => {
      const series = ids.map(id => ({ nome: nome(id), cor: cor(id), pts: serie(id, k, S.per) }));
      if (S.ant && unico) {
        series.push({
          nome: nome(ids[0]) + ' — período anterior',
          cor: cor(ids[0]),
          pts: serie(ids[0], k, S.per, S.per * DAY),
          tr: 1
        });
      }
      chart(host, series, { u: unidade, d: casas, t: nomeVar });
    }));

    dois.append(box('Perfil médio por hora', host => chart(host,
      ids.map(id => ({ nome: nome(id), cor: cor(id), pts: perfil(id, k, S.per) })),
      { u: unidade, d: casas, t: 'Perfil médio por hora', xf: t => Math.round(t) + 'h', tf: t => Math.round(t) + 'h' }
    )));
    painel.append(dois);

    // Tabela de estatísticas
    painel.append(el('h3', '', 'Estatísticas do período'));
    const tab = el('div', 'tab');
    const t = el('table');
    const head = el('tr');
    for (const tit of ['Parque', 'Medições', 'Mín.', 'Média', 'Máx.', 'Desvio-padrão', 'Última', 'Tendência/dia']) {
      head.append(el('th', '', tit));
    }
    t.append(head);

    for (const id of ids) {
      const st = est(serie(id, k, S.per));
      const tr = el('tr');
      tr.append(el('td', '', nome(id)));
      const vals = st ? [
        st.n,
        fmt(st.min, casas),
        fmt(st.m, casas),
        fmt(st.max, casas),
        fmt(st.sd, casas + 1),
        fmt(st.last, casas),
        num(st.tr) ? (st.tr >= 0 ? '+' : '') + fmt(st.tr, casas + 1) + ' ' + unidade : '—'
      ] : ['0', '—', '—', '—', '—', '—', '—'];
      for (const v of vals) tr.append(el('td', '', String(v)));
      t.append(tr);
    }
    tab.append(t);
    painel.append(tab);

    // Painel completo
    const primeiro = ids[0];
    if (primeiro) {
      painel.append(el('h3', '', 'Painel completo: ' + nome(primeiro)));
      const mini = el('div', 'mini');
      for (const v of Object.keys(V)) {
        mini.append(box(`${V[v][0]} (${V[v][1]})`, host => chart(host,
          [{ nome: V[v][0], cor: cor(primeiro), pts: serie(primeiro, v, S.per) }],
          { u: V[v][1], d: V[v][2], h: 210, t: V[v][0] }
        )));
      }
      painel.append(mini);
    }

    // Qualidade dos dados
    painel.append(el('h3', '', 'Qualidade e cobertura dos dados'));
    const qualidade = el('div', 'grid');
    const iniPer = S.per ? FIM - S.per * DAY : -Infinity;
    const dadosPer = D.filter(m => ids.includes(m.parque) && T(m) > iniPer && T(m) <= FIM);
    const campos = ['temperatura', 'umidade', 'co2eq'];
    const total = dadosPer.length * campos.length;
    const validos = dadosPer.reduce((s, m) => s + campos.filter(c => num(m[c])).length, 0);
    const cob = total ? (validos / total) * 100 : NaN;

    qualidade.append(
      card('Registros no período', String(dadosPer.length), ids.length + (ids.length === 1 ? ' parque selecionado' : ' parques selecionados')),
      card('Completude', num(cob) ? fmt(cob, 1) + '%' : '—', 'Campos principais preenchidos'),
      card('Última atualização', D.length ? quando(FIM) : '—', 'Horário mais recente no conjunto de dados')
    );
    painel.append(qualidade);

    // Dados brutos
    const bruto = el('details');
    bruto.append(el('summary', '', 'Ver dados brutos do período'));
    const bw = el('div', 'tab');
    const bt = el('table');
    const bh = el('tr');
    for (const h of ['Parque', 'Data/hora', 'Temp.', 'Umidade', 'CO₂ estimado']) bh.append(el('th', '', h));
    bt.append(bh);
    const amostra = dadosPer.slice().sort((a, b) => T(b) - T(a)).slice(0, 120);
    for (const m of amostra) {
      const r = el('tr');
      for (const x of [
        nome(m.parque), quando(T(m)),
        num(m.temperatura) ? fmt(m.temperatura, 1) + ' °C' : '—',
        num(m.umidade) ? fmt(m.umidade, 0) + '%' : '—',
        num(m.co2eq) ? fmt(m.co2eq, 0) + ' ppm' : '—'
      ]) r.append(el('td', '', x));
      bt.append(r);
    }
    bw.append(bt);
    bruto.append(bw);
    if (dadosPer.length > 120) bruto.append(el('p', 'mute', 'Mostrando os 120 registros mais recentes. Use "Baixar CSV" para acessar todos os registros.'));
    painel.append(bruto);

    // Metodologia
    const met = el('details');
    met.append(el('summary', '', 'Como interpretar a análise'));
    met.append(
      el('p', '', 'Mínimo, média, máximo e desvio-padrão resumem a distribuição das medições no período selecionado.'),
      el('p', '', 'A tendência por dia é uma estimativa linear da direção da série no período. Ela descreve o conjunto de dados e não é uma previsão.'),
      el('p', '', 'O perfil médio por hora agrupa as medições pelo horário do dia, ajudando a visualizar o ciclo diário de cada indicador.'),
      el('p', '', 'Ao selecionar vários parques, as linhas permitem comparar locais no mesmo gráfico. Para comparar um parque com o período anterior, selecione apenas um parque e ative a opção correspondente.')
    );
    painel.append(met);

    // Sensores
    const sens = el('details');
    sens.append(el('summary', '', 'Sensores e limitações'));
    const st2 = el('div', 'tab');
    const stt = el('table');
    const sth = el('tr');
    for (const h of ['Sensor', 'Mede', 'Faixa']) sth.append(el('th', '', h));
    stt.append(sth);
    for (const dados of [
      ['DHT22', 'Temperatura e umidade', '−40 a 80 °C; 0 a 100% UR'],
      ['MQ-135', 'CO₂ estimado (mistura de gases)', 'Calibra no ar do local = 350 ppm; alerta acima de 650']
    ]) {
      const r = el('tr');
      for (const v of dados) r.append(el('td', '', v));
      stt.append(r);
    }
    st2.append(stt);
    sens.append(st2, el('p', 'mute', 'Sensação térmica e ponto de orvalho são calculados a partir das medições de temperatura e umidade.'));
    painel.append(sens);
  }

  /* ============================================================
     CARREGAMENTO E RENDER
     ============================================================ */
  function aceitar(json) {
    const lista = Array.isArray(json) ? json : json?.medicoes;
    if (!Array.isArray(lista)) throw new Error('Formato de dados inválido.');

    const ids = new Set(CFG.PARQUES.map(p => p.id));
    const unicas = new Map();

    for (const m of lista) {
      if (!m || Number.isNaN(T(m))) continue;
      // só MQ-135 (CO2 estimado) + DHT22: descarta CO2 medido (MG811) e o MQ-135 antigo
      const { co2, mq135, ...limpo } = m;
      const n = limpo.parque === 'pina' ? { ...limpo, parque: 'governador-eduardo-campos' } : limpo;
      if (ids.has(n.parque)) unicas.set(`${n.parque}|${n.data_hora}`, n);
    }

    D = [...unicas.values()].map(enriquecer);
    FIM = D.length ? Math.max(...D.map(T)) : Date.now();
    cache.clear();

    const aviso = $('#aviso');
    if (aviso) {
      aviso.textContent = D.length
        ? `${D.length.toLocaleString('pt-BR')} medições disponíveis.`
        : 'Nenhuma medição disponível.';
    }
    render();
  }

  function render() {
    const pc = $('#p-cid'), pp = $('#p-pes'), tc = $('#t-cid'), tp = $('#t-pes');
    if (!pc || !pp || !tc || !tp) {
      console.error('SIMA: elementos principais do HTML não encontrados.');
      return;
    }

    const cid = S.aba === 'cid';
    pc.hidden = !cid;
    pp.hidden = cid;
    tc.setAttribute('aria-selected', String(cid));
    tp.setAttribute('aria-selected', String(!cid));
    tc.tabIndex = cid ? 0 : -1;
    tp.tabIndex = cid ? -1 : 0;
    tip(null, '', null);

    (cid ? cidadao : pesquisa)();
  }

  /* ============================================================
     INICIALIZAÇÃO
     ============================================================ */
  const tCid = $('#t-cid'), tPes = $('#t-pes');
  if (tCid && tPes) {
    tCid.onclick = () => { S.aba = 'cid'; render(); };
    tPes.onclick = () => { S.aba = 'pes'; render(); };

    const tabs = document.querySelector('.tabs');
    if (tabs) {
      tabs.onkeydown = ev => {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
        ev.preventDefault();
        S.aba = S.aba === 'cid' ? 'pes' : 'cid';
        render();
        (S.aba === 'cid' ? tCid : tPes).focus();
      };
    }
  }

  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(render, 200);
  });

  render();

  const embutido = window.SIMA_DADOS;
  const listaDe = json => Array.isArray(json) ? json : (json?.medicoes || []);

  // Busca as medições do ESP32 guardadas no Netlify (função /api/medicoes)
  async function carregarVivo() {
    if (!CFG.API_VIVO) return [];
    const r = await fetch(`${CFG.API_VIVO}?dias=${CFG.DIAS_VIVO}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const lista = await r.json();
    if (!Array.isArray(lista)) throw new Error('resposta inválida');
    return lista;
  }

  // Dados fixos do site (histórico): medicoes.json + dados.js
  const base = fetch(CFG.API_URL || CFG.ARQUIVO)
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(json => [...listaDe(embutido), ...listaDe(json)])
    .catch(err => {
      console.warn('SIMA: usando dados locais.', err);
      return listaDe(embutido);
    });

  let aoVivo = false, erroBanco = '';
  async function atualizar() {
    const hist = await base;
    let vivo = [];
    try {
      erroBanco = '';
      vivo = await carregarVivo();
      aoVivo = !!CFG.API_VIVO;
    } catch (err) {
      console.warn('SIMA: banco dos sensores indisponível; mostrando só o histórico.', err);
      aoVivo = false;
      erroBanco = String(err && err.message || err);
    }
    if (!hist.length && !vivo.length) throw new Error('sem dados');
    aceitar({ medicoes: [...hist, ...vivo] });
    const aviso = $('#aviso');
    if (aviso && !aoVivo && erroBanco) {
      aviso.textContent = `${D.length.toLocaleString('pt-BR')} medições (só histórico) · ⚠ sem conexão com o banco dos sensores: ${erroBanco}`;
    }
    if (aviso && aoVivo) {
      aviso.textContent = `${D.length.toLocaleString('pt-BR')} medições · dados ao vivo dos sensores` +
        ` (${vivo.length.toLocaleString('pt-BR')} do banco) · atualizado às ${hora(Date.now())}.`;
    }
  }

  atualizar().catch(err => {
    console.warn('SIMA: falha ao carregar medições.', err);
    const aviso = $('#aviso');
    if (aviso) aviso.textContent = 'Não foi possível carregar as medições.';
    render();
  });
  if (CFG.ATUALIZAR_MS) setInterval(() => { if (!document.hidden) atualizar().catch(() => {}); }, CFG.ATUALIZAR_MS);
})();