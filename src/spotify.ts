const { SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: secret } = process.env;

let token: { value: string; exp: number } | null = null;

async function getToken(): Promise<string> {
  if (token && token.exp > Date.now() + 10_000) return token.value;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error(`spotify token ${r.status}`);
  const d = (await r.json()) as { access_token: string; expires_in: number };
  token = { value: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return token.value;
}

/**
 * Acha a faixa pela API e devolve o URI de busca "artista faixa". O Spotify da TV ignora spotify:track:,
 * então abrimos a busca com o nome exato. Null sem credenciais ou resultado.
 */
// shortcut: client credentials (sem login, sem Premium), o app só abre a busca; Spotify Connect tocaria direto mas exige Premium + OAuth.
export async function searchUrl(q: string): Promise<string | null> {
  if (!id || !secret) return null;
  const r = await fetch(`https://api.spotify.com/v1/search?${new URLSearchParams({ q, type: 'track', limit: '1', market: 'BR' })}`, {
    headers: { authorization: `Bearer ${await getToken()}` },
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error(`spotify ${r.status}`);
  const d = (await r.json()) as { tracks: { items: { name: string; artists: { name: string }[] }[] } };
  const t = d.tracks.items[0];
  return t ? `spotify:search:${encodeURIComponent(`${t.artists[0].name} ${t.name}`)}` : null;
}
