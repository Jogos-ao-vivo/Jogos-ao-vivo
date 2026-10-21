// ===== Configurações da API =====
const memory = new Map();      
const upstreamCalls = [];      
let blockedUntil = 0;          

const MAX_CALLS_PER_MIN = 8;
const BLOCK_AFTER_429_MS = 30000;
const MAX_ENTRIES = 300;

function ttlSeconds(pathname) {
  if (/^\/v4\/competitions\/[^/]+\/matches/.test(pathname)) return 900;
  if (pathname === "/v4/matches") return 15;
  if (pathname.startsWith("/fighterapi/")) return 300; 
  if (pathname.startsWith("/apifootball/")) return 60; // Cache de 1 min para API-Football
  return 120;
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "X-Cache"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {headers: cors});
    }

    const url = new URL(request.url);
    const ttl = ttlSeconds(url.pathname);
    const now = Date.now();

    // ===== Rota para API-Football =====
    if (url.pathname.startsWith("/apifootball/")) {
      const targetPath = url.pathname.replace("/apifootball", "");
      const targetUrl = "https://v3.football.api-sports.io" + targetPath + url.search;
      
      // Coloque sua chave da API-Football nas Variáveis de Ambiente da Cloudflare como `API_FOOTBALL_KEY`
      // ou substitua a string abaixo se preferir hardcodar diretamente:
      const apiKey = env.API_FOOTBALL_KEY || "fdee527619fe1292aeb3235b94cc5c4d";

      try {
        const response = await fetch(targetUrl, {
          method: request.method,
          headers: {
            "x-apisports-key": apiKey
          }
        });

        const data = await response.text();
        return new Response(data, {
          status: response.status,
          headers: {...cors, "Content-Type": "application/json"}
        });
      } catch (err) {
        return new Response(JSON.stringify({error: "Erro ao conectar à API-Football"}), {
          status: 502,
          headers: {...cors, "Content-Type": "application/json"}
        });
      }
    }

    // Endpoints do FighterAPI via proxy
    if (url.pathname.startsWith("/fighterapi/")) {
      const targetPath = url.pathname.replace("/fighterapi", "/v1");
      const targetUrl = "https://mcp.fighterapi.com" + targetPath + url.search;
      const apiKey = env.FIGHTER_API_KEY || "sk_live_Tj0bSgx3oXNdPQAGAkor30x1cdpwGXdpA4FqA8iUkKk";

      try {
        const response = await fetch(targetUrl, {
          method: request.method,
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey
          },
          body: request.method === "POST" ? await request.text() : undefined
        });

        const data = await response.text();
        return new Response(data, {
          status: response.status,
          headers: {...cors, "Content-Type": "application/json"}
        });
      } catch (err) {
        return new Response(JSON.stringify({error: "Erro ao conectar à FighterAPI"}), {
          status: 502,
          headers: {...cors, "Content-Type": "application/json"}
        });
      }
    }

    if (request.method !== "GET" || !url.pathname.startsWith("/v4/")) {
      return new Response("Not found", {status: 404, headers: cors});
    }

    const key = url.pathname + url.search;
    const saved = memory.get(key);

    const reply = (entry, state) => new Response(entry.body, {
      status: entry.status,
      headers: {...cors, "Content-Type": entry.type, "X-Cache": state}
    });

    if (saved && now - saved.time < ttl * 1000) return reply(saved, "HIT");

    while (upstreamCalls.length && now - upstreamCalls[0] > 60000) upstreamCalls.shift();
    if (now < blockedUntil || upstreamCalls.length >= MAX_CALLS_PER_MIN) {
      if (saved) return reply(saved, "STALE");
      return new Response("Limite de consultas atingido. Tente novamente em instantes.", {
        status: 429,
        headers: {...cors, "Retry-After": "15"}
      });
    }
    upstreamCalls.push(now);

    let upstream;
    try {
      const options = {headers: {"X-Auth-Token": env.FOOTBALL_DATA_KEY}};
      if (ttl >= 120) {
        options.cf = {cacheEverything: true, cacheTtlByStatus: {"200-299": ttl, "300-599": -1}};
      }
      upstream = await fetch("https://api.football-data.org" + key, options);
    } catch (error) {
      if (saved) return reply(saved, "STALE");
      return new Response("Bad gateway", {status: 502, headers: cors});
    }

    if (upstream.ok) {
      const entry = {
        time: now,
        status: 200,
        type: upstream.headers.get("Content-Type") || "application/json",
        body: await upstream.text()
      };
      memory.set(key, entry);
      if (memory.size > MAX_ENTRIES) memory.delete(memory.keys().next().value);
      return reply(entry, "MISS");
    }

    if (upstream.status === 429) blockedUntil = now + BLOCK_AFTER_429_MS;

    if (saved) return reply(saved, "STALE");
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {...cors, "Content-Type": upstream.headers.get("Content-Type") || "text/plain"}
    });
  }
};
