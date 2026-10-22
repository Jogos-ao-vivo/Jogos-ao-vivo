// Servidor intermediário (Cloudflare Worker) para a football-data.org
// - guarda a chave em segredo (variável FOOTBALL_DATA_KEY)
// - libera o acesso pelo navegador (CORS)
// - guarda cada resposta por um tempo, para poucas pessoas gastarem poucas consultas
//   (o plano grátis permite só 10 consultas por minuto, somando todo mundo)
// - se a football-data recusar (erro 429) ou cair, devolve a última cópia boa
// - trava as consultas em 8 por minuto, deixando folga abaixo do limite de 10

const memory = new Map();      // chave -> {time, status, type, body}
const upstreamCalls = [];      // horários das últimas consultas feitas à football-data
let blockedUntil = 0;          // depois de um 429, para de consultar por um tempo

const MAX_CALLS_PER_MIN = 8;
const BLOCK_AFTER_429_MS = 30000;
const MAX_ENTRIES = 300;

// Quanto tempo uma resposta é considerada "fresca" (em segundos)
function ttlSeconds(pathname) {
  if (/^\/v4\/competitions\/[^/]+\/matches/.test(pathname)) return 900; // temporada inteira: 15 min
  if (pathname === "/v4/matches") return 15;                            // jogos de hoje / ao vivo: 15 s
  return 120;
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "X-Cache"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {headers: cors});
    }

    const url = new URL(request.url);
    if (request.method !== "GET" || !url.pathname.startsWith("/v4/")) {
      return new Response("Not found", {status: 404, headers: cors});
    }

    const key = url.pathname + url.search;
    const ttl = ttlSeconds(url.pathname);
    const now = Date.now();
    const saved = memory.get(key);

    const reply = (entry, state) => new Response(entry.body, {
      status: entry.status,
      headers: {...cors, "Content-Type": entry.type, "X-Cache": state}
    });

    // 1) resposta ainda fresca: não gasta consulta nenhuma
    if (saved && now - saved.time < ttl * 1000) return reply(saved, "HIT");

    // 2) trava de segurança: perto do limite, usa a cópia guardada
    while (upstreamCalls.length && now - upstreamCalls[0] > 60000) upstreamCalls.shift();
    if (now < blockedUntil || upstreamCalls.length >= MAX_CALLS_PER_MIN) {
      if (saved) return reply(saved, "STALE");
      return new Response("Limite de consultas atingido. Tente novamente em instantes.", {
        status: 429,
        headers: {...cors, "Retry-After": "15"}
      });
    }
    upstreamCalls.push(now);

    // 3) consulta a football-data.org
    let upstream;
    try {
      const options = {headers: {"X-Auth-Token": env.FOOTBALL_DATA_KEY}};
      if (ttl >= 120) {
        // respostas longas também ficam no cache da Cloudflare (só se deu certo)
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

    // 4) deu erro: prefere a última cópia boa a mostrar erro
    if (saved) return reply(saved, "STALE");
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {...cors, "Content-Type": upstream.headers.get("Content-Type") || "text/plain"}
    });
  }
};
