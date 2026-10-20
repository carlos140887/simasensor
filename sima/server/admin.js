#!/usr/bin/env node
// Ferramenta de linha de comando para administrar o SIMA.
//
//   npm run admin -- dispositivo:novo <parque> "<nome>"   cria placa e mostra o token
//   npm run admin -- dispositivo:listar
//   npm run admin -- dispositivo:desativar <id>
//   npm run admin -- parques
//   npm run admin -- importar <arquivo.json|arquivo.js> [...]
//   npm run admin -- exportar [public/dados/medicoes.json]   snapshot para o modo estático
const fs = require('node:fs');
const DB = require('./db');
const { validarLeitura } = require('./validar');

const [cmd, ...args] = process.argv.slice(2);

// Nomes antigos de parques usados nos arquivos legados
const ALIAS = { pina: 'governador-eduardo-campos' };

function importar(arquivos) {
  if (!arquivos.length) throw new Error('Informe ao menos um arquivo.');
  for (const arq of arquivos) {
    let txt = fs.readFileSync(arq, 'utf8').trim();
    // dados.js no formato "window.SIMA_DADOS = {...};"
    txt = txt.replace(/^[^{[]*=\s*/, '').replace(/;\s*$/, '');
    const json = JSON.parse(txt);
    const lista = Array.isArray(json) ? json : json.medicoes;

    const porParque = new Map();
    let rejeitadas = 0;
    for (const m of lista) {
      const parque = ALIAS[m.parque] || m.parque;
      // importação de histórico: não há limite de "futuro" relativo a agora
      const r = validarLeitura(m, Infinity);
      if (!r.ok || !DB.parqueExiste(parque)) { rejeitadas++; continue; }
      if (!porParque.has(parque)) porParque.set(parque, []);
      porParque.get(parque).push(r.leitura);
    }

    let ins = 0, dup = 0;
    for (const [parque, leituras] of porParque) {
      const r = DB.inserirMedicoes(parque, null, leituras);
      ins += r.inseridas; dup += r.duplicadas;
    }
    console.log(`${arq}: ${ins} inseridas, ${dup} já existiam, ${rejeitadas} rejeitadas`);
  }
}

const comandos = {
  'dispositivo:novo'([parque, nome]) {
    if (!parque || !nome) throw new Error('Uso: dispositivo:novo <parque> "<nome>"');
    const { id, token } = DB.criarDispositivo(parque, nome);
    console.log(`Dispositivo #${id} criado para ${parque}.\n`);
    console.log(`  TOKEN: ${token}\n`);
    console.log('Copie o token para o sketch do Arduino (SIMA_TOKEN). Ele NÃO será mostrado de novo.');
  },
  'dispositivo:listar'() {
    console.table(DB.listarDispositivos().map(d => ({
      ...d, ultimo_contato: d.ultimo_contato ? new Date(d.ultimo_contato).toLocaleString('pt-BR') : '—'
    })));
  },
  'dispositivo:desativar'([id]) {
    console.log(DB.desativarDispositivo(Number(id)) ? `Dispositivo #${id} desativado.` : 'Não encontrado.');
  },
  parques() {
    console.table(DB.listarParques().map(p => ({
      id: p.id, nome: p.nome,
      ultima: p.ultima ? new Date(p.ultima.medido_em).toLocaleString('pt-BR') : '—'
    })));
  },
  importar,
  // Gera um JSON estático com todo o banco, para hospedar o site sem servidor.
  exportar([arq = 'public/dados/medicoes.json']) {
    const r = DB.resumo();
    const linhas = r.n ? DB.serie({ parques: DB.listarParques().map(p => p.id), de: r.ini - 1, ate: r.fim }) : [];
    const parques = DB.listarParques().map(({ id, nome, bairro }) => ({ id, nome, bairro }));
    fs.mkdirSync(require('node:path').dirname(arq), { recursive: true });
    fs.writeFileSync(arq, JSON.stringify({
      gerado_em: new Date().toISOString(),
      parques,
      medicoes: linhas.map(({ n, ...l }) => l)
    }));
    console.log(`${linhas.length} medições exportadas para ${arq}`);
  }
};

try {
  const fn = comandos[cmd];
  if (!fn) {
    console.log('Comandos: ' + Object.keys(comandos).join(', '));
    process.exitCode = 1;
  } else fn(args);
} catch (e) {
  console.error('Erro:', e.message);
  process.exitCode = 1;
}
