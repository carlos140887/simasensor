# simasensor
sensor

## Site no Netlify (simarec.netlify.app)
- `site/` – site estático (publish directory)
- `netlify/functions/medicoes.mjs` – `/api/medicoes`: recebe as medições do ESP32 (POST) e entrega ao site (GET), guardando no Netlify Blobs
- Variável de ambiente no Netlify: `SIMA_DISPOSITIVOS = token=parque`
