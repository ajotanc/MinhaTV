const API = 'https://www.googleapis.com/youtube/v3';

/** "PT1H2M3S" -> 3723. Transmissões ao vivo vêm como "P0D" e valem 0. */
export function seconds(iso: string): number {
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

/** Primeiro candidato que não é Short (até 1 min) nem compilação longa, salvo se o pedido já fala em hora/completo. */
export function pick(ids: string[], durations: Record<string, number>, query: string): string | undefined {
  const wantsLong = /\b(horas?|hour|completo|completa|full|ao vivo|live)\b/i.test(query);
  const ok = (d: number) => d > 60 && (wantsLong || d <= 30 * 60);
  return ids.find((id) => ok(durations[id] ?? 0)) ?? ids[0];
}

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = process.env.YOUTUBE_API_KEY as string;
  const r = await fetch(`${API}/${path}?${new URLSearchParams({ ...params, key })}`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`youtube ${r.status}`);
  return (await r.json()) as T;
}

/** URL do melhor vídeo da busca do YouTube, ou null sem chave/resultado. */
// shortcut: 2 chamadas por busca (100 + 1 unidades da cota diária de 10 mil), sem cache.
export async function watchUrl(q: string): Promise<string | null> {
  if (!process.env.YOUTUBE_API_KEY) return null;
  const found = await get<{ items?: { id: { videoId: string } }[] }>('search', {
    part: 'id', type: 'video', maxResults: '5', q, regionCode: 'BR', relevanceLanguage: 'pt',
  });
  const ids = (found.items ?? []).map((i) => i.id.videoId);
  if (!ids.length) return null;
  const details = await get<{ items?: { id: string; contentDetails: { duration: string } }[] }>('videos', {
    part: 'contentDetails', id: ids.join(','),
  }).catch(() => ({ items: [] })); // sem as durações, vale o primeiro resultado
  const durations = Object.fromEntries((details.items ?? []).map((v) => [v.id, seconds(v.contentDetails.duration)]));
  return `https://www.youtube.com/watch?v=${pick(ids, durations, q)}`;
}
