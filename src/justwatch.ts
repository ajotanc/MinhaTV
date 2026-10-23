import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** id do serviço -> deep link (intent://...) do título */
export type Links = Record<string, string>;
export interface Episode {
  season: number;
  episode: number;
}

export interface Offer {
  monetizationType: string;
  package: { clearName: string };
  deeplinkURL: string | null;
}
interface Node {
  offers?: Offer[];
  seasons?: { content: { seasonNumber: number }; episodes: { content: { episodeNumber: number }; offers?: Offer[] }[] }[];
}

// O JustWatch tem variantes como "Netflix Standard with Ads", então compara pelo prefixo
const SERVICES: [prefix: string, id: string][] = [
  ['Netflix', 'netflix'],
  ['Amazon Prime Video', 'prime'],
  ['Amazon Video', 'prime'],
  ['Disney Plus', 'disney'],
  ['HBO Max', 'max'],
  ['Max', 'max'],
  ['Globoplay', 'globoplay'],
  ['YouTube', 'youtube'],
];
const serviceOf = (name: string) => SERVICES.find(([p]) => name.startsWith(p))?.[1];

/** Um link por serviço, preferindo assinatura (já inclusa) a aluguel/compra. */
export function bestLinks(offers: Offer[]): Links {
  const links: Links = {};
  const flat = new Set<string>();
  for (const o of offers) {
    const s = serviceOf(o.package.clearName);
    if (!s || !o.deeplinkURL) continue;
    const isFlat = o.monetizationType === 'FLATRATE';
    if (!(s in links) || (isFlat && !flat.has(s))) links[s] = o.deeplinkURL;
    if (isFlat) flat.add(s);
  }
  return links;
}

const OFFERS = 'offers(country:$c,platform:ANDROID_TV){monetizationType package{clearName} deeplinkURL(platform:ANDROID_TV)}';
const head = (first: number) => `query($t:String!,$c:Country!){popularTitles(country:$c,first:${first},filter:{searchQuery:$t}){edges{node{`;
const QUERY = `${head(5)}${OFFERS}}}}}`;
// A API recusa consultas acima de 350k de complexidade: por isso só 2 títulos e 50 episódios por temporada.
// shortcut: temporadas com mais de 50 episódios perdem o fim, aumentar o limit só junto com a redução do first.
const QUERY_EPISODES = `${head(2)}${OFFERS} ... on Show{seasons{content(country:$c,language:"pt"){seasonNumber} episodes(limit:50){content(country:$c,language:"pt"){episodeNumber} ${OFFERS}}}}}}}}`;

// Cache em arquivo: acelera repetições e segura a queda da API. Só guarda acertos.
const FILE = process.env.CACHE_FILE ?? 'data/cache.json';
const TTL = 7 * 24 * 3600 * 1000;
let cache: Record<string, { at: number; links: Links }> = {};
try {
  cache = JSON.parse(readFileSync(FILE, 'utf8'));
} catch {
  /* sem cache ainda */
}
function save() {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(cache));
  } catch (e) {
    console.error(e);
  }
}

/**
 * Links do título em cada serviço (vazio se não achou). Com `ep`, usa o link do episódio quando
 * o serviço tem (Prime e Disney+ têm; a Netflix só devolve o da série).
 */
// shortcut: API não oficial do JustWatch, pode mudar sem aviso, atualizar este arquivo se quebrar.
export async function findLinks(title: string, ep?: Episode, country = 'BR'): Promise<Links> {
  const key = `${title.trim().toLowerCase()}|${ep ? `${ep.season}x${ep.episode}` : ''}`;
  const hit = cache[key];
  if (hit && Date.now() - hit.at < TTL) return hit.links;

  const r = await fetch('https://apis.justwatch.com/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: ep ? QUERY_EPISODES : QUERY, variables: { t: title, c: country } }),
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error(`justwatch ${r.status}`);
  const data = (await r.json()) as { data?: { popularTitles?: { edges?: { node: Node }[] } } };
  for (const { node } of data.data?.popularTitles?.edges ?? []) {
    const epOffers = ep
      ? node.seasons?.find((s) => s.content.seasonNumber === ep.season)?.episodes.find((e) => e.content.episodeNumber === ep.episode)?.offers
      : undefined;
    // episódio não achado: cai no link da série
    const links = { ...bestLinks(node.offers ?? []), ...bestLinks(epOffers ?? []) };
    if (Object.keys(links).length) {
      cache[key] = { at: Date.now(), links };
      save();
      return links;
    }
  }
  return {};
}
