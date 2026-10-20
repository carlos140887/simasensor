/*
  SIMA · firmware do sensor (ESP32)

  Lê DHT22 (temperatura/umidade), MG811 (CO₂) e MQ-135 (gases) e envia para
  POST /api/leituras do servidor SIMA.

  - Hora real via NTP: cada leitura vai com o horário em que foi medida.
  - Se o Wi-Fi cair, as leituras ficam guardadas na memória (até BUFFER_MAX)
    e são enviadas todas juntas quando a conexão voltar (o servidor ignora
    duplicadas, então reenviar é seguro).

  Bibliotecas (Gerenciador de Bibliotecas da IDE Arduino):
    - "DHT sensor library" (Adafruit) + "Adafruit Unified Sensor"
  Placa: "ESP32 Dev Module" (pacote esp32 da Espressif)

  Ligações sugeridas:
    DHT22  dados -> GPIO 4  (resistor de 10k para 3V3)
    MG811  AOUT  -> GPIO 34 (passando pelo módulo amplificador do MG811)
    MQ-135 AOUT  -> GPIO 35 (use divisor de tensão se o módulo for de 5 V!)
*/
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <DHT.h>
#include <time.h>

// ======== CONFIGURE AQUI ========
const char* WIFI_SSID  = "SEU_WIFI";
const char* WIFI_SENHA = "SUA_SENHA";
// Endereço do servidor. Na rede local: "http://192.168.0.10:3000"
const char* SIMA_URL   = "https://seu-servidor.com";
// Gerado com: npm run admin -- dispositivo:novo <parque> "<nome>"
const char* SIMA_TOKEN = "sima_COLE_O_TOKEN_AQUI";
const char* FIRMWARE   = "2.0.0";

const uint32_t INTERVALO_MS = 60UL * 1000;  // uma leitura por minuto
const int      BUFFER_MAX   = 240;          // 4 h de leituras guardadas offline

// Pinos
#define PINO_DHT   4
#define PINO_MG811 34
#define PINO_MQ135 35

// Calibração — AJUSTE com os valores do SEU sensor (veja README)
const float MG811_V400   = 2.75;   // tensão (V) na saída do módulo ao ar livre (~420 ppm)
const float MG811_DELTA  = 0.17;   // quanto a tensão cai (V) de 400 para 1000 ppm
const float MQ135_RL     = 10.0;   // resistor de carga do módulo (kΩ)
const float MQ135_R0     = 76.63;  // resistência no ar limpo (kΩ) — calibrar!
// =================================

DHT dht(PINO_DHT, DHT22);

struct Leitura {
  time_t t;          // segundos UTC (0 = relógio não sincronizado)
  float temp, umid, co2, mq135;
};
Leitura buffer[BUFFER_MAX];
int nBuffer = 0;
uint32_t ultimaLeitura = 0;

// ---------- sensores ----------
float lerTensao(int pino) {
  // média de 10 amostras para reduzir ruído
  uint32_t soma = 0;
  for (int i = 0; i < 10; i++) { soma += analogReadMilliVolts(pino); delay(5); }
  return soma / 10.0 / 1000.0;
}

float lerCO2() {
  float v = lerTensao(PINO_MG811);
  // curva do datasheet: a tensão cai linearmente com log10(ppm)
  float inclinacao = MG811_DELTA / (log10(400) - log10(1000));  // negativa
  float ppm = pow(10, (v - MG811_V400) / inclinacao + log10(400));
  return (ppm > 0 && ppm < 10000) ? ppm : NAN;
}

float lerMQ135() {
  float v = lerTensao(PINO_MQ135);
  if (v <= 0.01) return NAN;
  float rs = (3.3 - v) / v * MQ135_RL;
  float ppm = 116.6020682 * pow(rs / MQ135_R0, -2.769034857);  // curva para CO₂ equivalente
  return (ppm > 0 && ppm < 10000) ? ppm : NAN;
}

// ---------- rede ----------
void conectarWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("Wi-Fi...");
  WiFi.begin(WIFI_SSID, WIFI_SENHA);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(250); Serial.print('.'); }
  Serial.println(WiFi.status() == WL_CONNECTED ? " ok" : " falhou");
}

bool relogioOk() { return time(nullptr) > 1600000000; }  // depois de 2020

// adiciona um número ou null ao JSON
void jsonNum(String& s, const char* nome, float v, int casas) {
  s += '"'; s += nome; s += "\":";
  s += isnan(v) ? String("null") : String(v, casas);
}

bool enviarBuffer() {
  if (nBuffer == 0) return true;
  if (WiFi.status() != WL_CONNECTED) return false;

  String corpo = "{\"firmware\":\"" + String(FIRMWARE) + "\",\"leituras\":[";
  for (int i = 0; i < nBuffer; i++) {
    Leitura& l = buffer[i];
    if (i) corpo += ',';
    corpo += '{';
    if (l.t) { corpo += "\"medido_em\":"; corpo += String((uint32_t)l.t); corpo += ','; }
    jsonNum(corpo, "temperatura", l.temp, 1);  corpo += ',';
    jsonNum(corpo, "umidade", l.umid, 1);      corpo += ',';
    jsonNum(corpo, "co2", l.co2, 0);           corpo += ',';
    jsonNum(corpo, "mq135", l.mq135, 0);
    corpo += '}';
  }
  corpo += "]}";

  HTTPClient http;
  WiFiClientSecure seguro;
  WiFiClient simples;
  String url = String(SIMA_URL) + "/api/leituras";
  if (url.startsWith("https")) {
    seguro.setInsecure();  // simples para começar; em produção use setCACert()
    http.begin(seguro, url);
  } else {
    http.begin(simples, url);
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + SIMA_TOKEN);
  http.setTimeout(10000);

  int status = http.POST(corpo);
  Serial.printf("POST %d leitura(s) -> HTTP %d\n", nBuffer, status);
  if (status > 0) Serial.println(http.getString());
  http.end();

  // 201 = gravou; 422 = nada válido (não adianta reenviar)
  if (status == 201 || status == 422) { nBuffer = 0; return true; }
  if (status == 401) Serial.println("Token inválido! Confira SIMA_TOKEN.");
  return false;  // erro de rede/servidor: mantém no buffer e tenta depois
}

// ---------- programa ----------
void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  dht.begin();
  conectarWifi();
  configTime(0, 0, "pool.ntp.org", "a.st1.ntp.br");  // NTP em UTC
  Serial.println("Aquecendo sensores de gás (MG811/MQ-135 precisam de alguns minutos)...");
}

void loop() {
  if (millis() - ultimaLeitura < INTERVALO_MS && ultimaLeitura != 0) { delay(100); return; }
  ultimaLeitura = millis();

  Leitura l;
  l.t = relogioOk() ? time(nullptr) : 0;  // sem hora certa, o servidor usa a hora de chegada
  l.temp = dht.readTemperature();
  l.umid = dht.readHumidity();
  l.co2 = lerCO2();
  l.mq135 = lerMQ135();
  Serial.printf("T=%.1f U=%.1f CO2=%.0f MQ=%.0f\n", l.temp, l.umid, l.co2, l.mq135);

  // sem relógio não dá para guardar offline (a hora ficaria errada)
  if (!l.t && nBuffer > 0) nBuffer = 0;
  if (nBuffer == BUFFER_MAX) {  // buffer cheio: descarta a mais antiga
    memmove(buffer, buffer + 1, sizeof(Leitura) * (BUFFER_MAX - 1));
    nBuffer--;
  }
  buffer[nBuffer++] = l;

  conectarWifi();
  enviarBuffer();
}
