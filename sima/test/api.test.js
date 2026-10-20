// Testes da API. Rodar com: npm test
// Usa um banco temporário, nunca o banco real.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sima-'));
process.env.DB_PATH = path.join(dir, 'teste.db');

const DB = require('../server/db');
const servidor = require('../server/server');
const { validarLeitura } = require('../server/validar');

let base, token;

before(async () => {
  token = DB.criarDispositivo('jaqueira', 'teste').token;
  await new Promise(r => servidor.listen(0, r));
  base = `http://localhost:${servidor.address().port}`;
});
after(() => { servidor.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const post = (corpo, tk = token) => fetch(`${base}/api/leituras`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
  body: JSON.stringify(corpo)
});

test('validação descarta só o campo inválido', () => {
  const r = validarLeitura({ temperatura: 200, umidade: '65,5', co2: 450 });
  assert.equal(r.ok, true);
  assert.equal(r.leitura.temperatura, null);
  assert.equal(r.leitura.umidade, 65.5);
  assert.equal(r.avisos.length, 1);
});

test('validação rejeita data antes de 2020 e no futuro', () => {
  assert.equal(validarLeitura({ temperatura: 25, medido_em: 1000 }).ok, false);
  assert.equal(validarLeitura({ temperatura: 25, medido_em: Date.now() + 3600e3 }).ok, false);
});

test('rejeita token inválido', async () => {
  const r = await post({ temperatura: 25 }, 'sima_token_que_nao_existe_123');
  assert.equal(r.status, 401);
});

test('grava lote, ignora duplicadas e limita frequência', async () => {
  const t = Date.now() - 60_000;
  const r = await post({ leituras: [
    { temperatura: 28, umidade: 70, co2: 450, mq135: 100, medido_em: t },
    { temperatura: 28, umidade: 70, co2: 450, mq135: 100, medido_em: t },   // duplicada
    { temperatura: 'abc' }                                                   // inválida
  ] });
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.inseridas, 1);
  assert.equal(j.duplicadas, 1);
  assert.equal(j.rejeitadas.length, 1);

  const r2 = await post({ temperatura: 29 });
  assert.equal(r2.status, 429);
});

test('consulta devolve a leitura e a última do parque', async () => {
  const m = await (await fetch(`${base}/api/medicoes?parques=jaqueira&agrupar=nenhum`)).json();
  assert.equal(m.medicoes.length, 1);
  assert.equal(m.medicoes[0].temperatura, 28);

  const p = await (await fetch(`${base}/api/parques`)).json();
  assert.equal(p.parques.find(x => x.id === 'jaqueira').ultima.co2, 450);
});

test('parâmetros inválidos dão 400', async () => {
  assert.equal((await fetch(`${base}/api/medicoes?parques=nao-existe`)).status, 400);
  assert.equal((await fetch(`${base}/api/medicoes?agrupar=semana`)).status, 400);
});
