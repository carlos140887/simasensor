# SIMA · Sistema de Monitoramento Ambiental

Clima e qualidade do ar nos parques do Recife, medidos por sensores em Arduino/ESP32.

```
 ESP32 + sensores  ──POST /api/leituras──▶  Servidor Node.js  ──▶  SQLite (data/sima.db)
 (DHT22, MG811,       (token por placa)      server/server.js
  MQ-135)                                         │
                                                  ▼
                         Navegador  ◀──GET /api/...──  site (public/)
```

## Como rodar

Precisa só do **Node.js 22.5 ou mais novo**. Não tem nenhuma dependência para instalar.

```bash
npm run importar-legado   # importa os dados antigos (dados.js / medicoes.json) para o banco
npm start                 # abre em http://localhost:3000
```

## Ligando um sensor

1. Crie a placa no banco e copie o token (ele aparece **uma vez só**):
   ```bash
   npm run admin -- dispositivo:novo jaqueira "ESP32 Jaqueira #1"
   ```
2. Abra `arduino/sima_sensor/sima_sensor.ino`, preencha Wi-Fi, `SIMA_URL` e `SIMA_TOKEN` e grave no ESP32.
3. Sem hardware? Teste com o simulador:
   ```bash
   npm run simular -- <TOKEN>
   ```

Outros comandos: `dispositivo:listar`, `dispositivo:desativar <id>`, `parques`, `importar <arquivo>`, `exportar`.

### Calibração dos sensores de gás
- **MG811**: deixe ligado 24–48 h, depois meça a tensão de saída ao ar livre (≈ 420 ppm) e coloque em `MG811_V400`.
- **MQ-135**: depois do aquecimento, ao ar livre, calcule `Rs = (3,3 − V) / V × RL` e use como `MQ135_R0`.
- Sem calibração, use esses valores como **indicadores de variação**, não como medida exata.

## Banco de dados

SQLite, um arquivo só (`data/sima.db`). Esquema completo em `server/schema.sql`.

| Tabela | O que guarda |
|---|---|
| `parques` | Locais monitorados (id, nome, bairro, coordenadas) |
| `dispositivos` | Cada placa instalada; guarda só o **hash** do token |
| `medicoes` | Leituras: parque, placa, `medido_em`, temperatura, umidade, co2, mq135 |

Decisões importantes:
- **Datas em milissegundos UTC** (número inteiro): buscas por período rápidas e sem confusão de fuso. O fuso de Recife é aplicado só na tela e nos agrupamentos por dia.
- **`UNIQUE(parque_id, medido_em)`**: se o Arduino reenviar a mesma leitura depois de uma queda do Wi-Fi, ela não duplica. (Os seus `medicoes.json` e `dados.js` antigos tinham 211 leituras repetidas; foram descartadas na importação.)
- **Índice `(parque_id, medido_em)`**: quase toda consulta é "parque X entre as datas A e B".
- **`CHECK` de faixa** em cada coluna e **NULL para sensor com defeito** (nunca 0, que seria uma leitura "verdadeira").
- **Sensação térmica e ponto de orvalho não são gravados**: são calculados a partir de temperatura e umidade.
- **Agregação no banco**: o site pede médias de 5 min, por hora ou por dia conforme o período, então não precisa baixar milhares de linhas mesmo com sensores enviando a cada minuto.
- **WAL**: o site lê enquanto os sensores escrevem, sem travar.

Backup: copie `data/sima.db` (com o servidor parado) ou use `sqlite3 data/sima.db ".backup backup.db"`.

## API

| Método | Rota | Uso |
|---|---|---|
| POST | `/api/leituras` | Sensor envia uma leitura ou um lote `{ leituras: [...] }`. Header `Authorization: Bearer <token>` |
| GET | `/api/parques` | Parques + última leitura de cada um |
| GET | `/api/medicoes?parques=a,b&de=&ate=&agrupar=` | Série temporal (`agrupar`: `auto`, `nenhum`, `5min`, `hora`, `dia`) |
| GET | `/api/perfil?...` | Média por hora do dia |
| GET | `/api/estatisticas?...` | Mín./máx./média/desvio sobre as leituras originais |
| GET | `/api/medicoes.csv?...` | Download das leituras originais |
| GET | `/api/saude` | Verificação do servidor |

`de`/`ate` aceitam milissegundos ou data ISO. Exemplo de envio:

```bash
curl -X POST http://localhost:3000/api/leituras \
  -H "Authorization: Bearer sima_..." -H "Content-Type: application/json" \
  -d '{"temperatura": 28.4, "umidade": 71, "co2": 450, "mq135": 120}'
```

Proteções: token por placa, limite de 1 envio a cada 10 s por placa, máximo de 500 leituras por lote, leitura com data antes de 2020 ou no futuro é rejeitada.

## Estrutura

```
server/            back-end
  server.js        rotas HTTP + arquivos do site
  db.js            conexão, migrações e consultas SQL
  schema.sql       tabelas e índices
  validar.js       validação das leituras
  admin.js         linha de comando (dispositivos, importar, exportar)
public/            site
  index.html
  css/style.css
  js/app.js        estado, abas, atualização automática
  js/api.js        única camada que busca dados (API ou JSON estático)
  js/clima.js      cálculos e classificações (sem DOM)
  js/grafico.js    gráficos SVG
  js/views/        telas "Para o cidadão" e "Pesquisa"
arduino/           firmware do ESP32
scripts/           simulador de sensor e dados antigos
test/              testes (npm test)
```

## Hospedagem

- **Com sensores ao vivo**: precisa de um servidor que rode Node e guarde o arquivo do banco (Render, Railway, Fly.io com volume persistente, uma VPS, ou até um Raspberry Pi na rede). Use HTTPS.
- **Só demonstração (GitHub Pages)**: rode `npm run admin -- exportar` e publique a pasta `public/`. Sem a API, o site carrega `public/dados/medicoes.json` sozinho e mostra "Modo demonstração".
- Site e API em domínios diferentes: preencha `API.BASE` em `public/js/config.js` e `CORS_ORIGINS` no `.env`.
