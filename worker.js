// Servidor intermediário (Cloudflare Worker) para a football-data.org
// - guarda a chave em segredo (variável FOOTBALL_DATA_KEY)
// - libera o acesso pelo navegador (CORS)
// - guarda a resposta por alguns segundos, para não estourar o limite de 10 consultas por minuto
export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {headers: cors});
    }

    const url = new URL(request.url);
    if (request.method !== "GET" || !url.pathname.startsWith("/v4/")) {
      return new Response("Not found", {status: 404, headers: cors});
    }

    const upstream = await fetch("https://api.football-data.org" + url.pathname + url.search, {
      headers: {"X-Auth-Token": env.FOOTBALL_DATA_KEY},
      cf: {cacheTtl: 8, cacheEverything: true}
    });

    const headers = new Headers(upstream.headers);
    Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
    return new Response(upstream.body, {status: upstream.status, headers});
  }
};
