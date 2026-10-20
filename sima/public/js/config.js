// Configuração do front-end. Os parques vêm do servidor (/api/parques);
// aqui ficam só as regras de exibição.

export const API = {
  // Vazio = mesmo servidor que entrega o site. Se hospedar o site separado
  // (ex.: GitHub Pages), coloque a URL do servidor: 'https://sima.exemplo.com'
  BASE: '',
  // Usado quando a API não responde (modo estático / demonstração)
  ARQUIVO_LOCAL: 'dados/medicoes.json',
  ATUALIZAR_MS: 60_000
};

export const CORES = ['#0f7ea3', '#d8503f', '#d48806', '#2e9d5b', '#8a4fa0', '#5b6b73', '#c2185b', '#00897b'];

// [nome, unidade, casas decimais]
export const VARS = {
  temperatura: ['Temperatura', '°C', 1],
  umidade: ['Umidade relativa', '%', 0],
  co2: ['CO₂', 'ppm', 0],
  mq135: ['Gases (MQ-135)', 'ppm eq.', 0],
  sensacao: ['Sensação térmica', '°C', 1],
  orvalho: ['Ponto de orvalho', '°C', 1]
};

export const SENSORES = ['temperatura', 'umidade', 'co2', 'mq135'];

// Faixas de classificação: [limite de "bom", limite de "atenção"] — acima disso é "ruim".
// Temperatura e umidade têm faixa inferior e superior.
export const FAIXAS = {
  temperatura: { baixo: [18, 15], alto: [27, 30] },
  sensacao: { baixo: [18, 15], alto: [27, 32] },
  umidade: { baixo: [40, 30], alto: [70, 85] },
  co2: { alto: [800, 1200] },
  mq135: { alto: [100, 250] }
};

// Escala visual de cada variável nos medidores (mín., máx.)
export const ESCALA = {
  temperatura: [15, 40],
  sensacao: [15, 45],
  umidade: [0, 100],
  co2: [300, 2500],
  mq135: [0, 1000]
};

export const PERIODOS = [['24 h', 1], ['7 dias', 7], ['30 dias', 30], ['Tudo', 0]];

export const DIA = 864e5;
export const LEITURA_ANTIGA_MS = 3 * 3600e3;
