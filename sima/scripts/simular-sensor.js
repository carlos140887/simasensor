#!/usr/bin/env node
// Finge ser um Arduino: envia uma leitura plausível a cada 15 s.
// Uso: npm run simular -- <TOKEN> [http://localhost:3000]
const [token, base = 'http://localhost:3000'] = process.argv.slice(2);
if (!token) {
  console.log('Uso: npm run simular -- <TOKEN> [url]\nCrie um token com: npm run admin -- dispositivo:novo jaqueira "Simulador"');
  process.exit(1);
}

const ruido = a => (Math.random() - .5) * a;

async function enviar() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  const ciclo = Math.sin(((h - 9) / 24) * 2 * Math.PI); // pico de calor ~15h
  const leitura = {
    temperatura: +(27 + 4 * ciclo + ruido(.6)).toFixed(1),
    umidade: +(72 - 12 * ciclo + ruido(3)).toFixed(1),
    co2: Math.round(440 + 60 * Math.max(0, ciclo) + ruido(30)),
    mq135: Math.round(120 + 40 * Math.max(0, ciclo) + ruido(20))
  };
  try {
    const r = await fetch(`${base}/api/leituras`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ firmware: 'simulador', leituras: [leitura] })
    });
    console.log(new Date().toLocaleTimeString('pt-BR'), r.status, JSON.stringify(leitura));
  } catch (e) {
    console.log('falha:', e.message);
  }
}

enviar();
setInterval(enviar, 15_000);
