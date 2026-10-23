import { existsSync, readFileSync } from 'node:fs';

/** Um título como o JustWatch o devolve: nome em português e o original (que muita gente fala em inglês). */
export interface TitleRow {
  pt: string;
  en?: string;
}

interface ModelValue {
  id: string;
  name: { value: string; synonyms: string[] };
}

const QUERY = (sort: string) =>
  `query($c:Country!,$p:[String!],$n:Int!){popularTitles(country:$c,first:$n,sortBy:${sort},filter:{packages:$p}){edges{node{` +
  'content(country:$c,language:"pt"){title} en:content(country:$c,language:"en"){title}}}}}';

/** Os mais populares (POPULAR) ou em alta (TRENDING) do JustWatch no Brasil, nos serviços `packages` (ex.: prv, dnp). */
// shortcut: API não oficial do JustWatch, a mesma de justwatch.ts; se quebrar, a lista antiga em skill/titles.json continua valendo.
export async function fetchTitles(packages: string[], sort: 'POPULAR' | 'TRENDING', n = 100, country = 'BR'): Promise<TitleRow[]> {
  const r = await fetch('https://apis.justwatch.com/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY(sort), variables: { c: country, p: packages, n } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`justwatch ${r.status}`);
  const data = (await r.json()) as { data?: { popularTitles?: { edges?: { node: { content?: { title: string }; en?: { title: string } } }[] } } };
  return (data.data?.popularTitles?.edges ?? []).flatMap(({ node }) => (node.content?.title ? [{ pt: node.content.title, en: node.en?.title }] : []));
}

// Valores de slot não aceitam alguns símbolos; espaços sobrando e o tamanho máximo também são recusados
const clean = (s: string) => s.replace(/[<>{}[\]\\|^~`"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Tipo de slot TITLE para o modelo: o nome em português como valor e o original como sinônimo, sem repetir nada. */
export function buildTitleType(rows: TitleRow[]): { name: 'TITLE'; values: ModelValue[] } {
  const used = new Set<string>();
  const ids = new Set<string>();
  const values: ModelValue[] = [];
  for (const row of rows) {
    const value = clean(row.pt);
    if (value.length < 2 || used.has(value.toLowerCase())) continue;
    used.add(value.toLowerCase());
    const synonyms: string[] = [];
    const en = row.en ? clean(row.en) : '';
    if (en.length >= 2 && !used.has(en.toLowerCase())) {
      used.add(en.toLowerCase());
      synonyms.push(en);
    }
    let id = slug(value) || `t${values.length}`;
    while (ids.has(id)) id += '_';
    ids.add(id);
    values.push({ id, name: { value, synonyms } });
  }
  return { name: 'TITLE', values };
}

/** Favoritos de um arquivo de texto: uma linha por título, "Título em português | Título original"; # comenta. */
export function readExtra(path: string): TitleRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [pt, en] = l.split('|').map((s) => s.trim());
      return { pt, en };
    });
}

/** Favoritos primeiro, depois os populares e os em alta intercalados (se o limite de valores cortar, nenhum grupo some). */
export async function collectTitles(packages: string[], n: number, extraPath: string): Promise<TitleRow[]> {
  const [popular, trending] = await Promise.all([fetchTitles(packages, 'POPULAR', n), fetchTitles(packages, 'TRENDING', n)]);
  const rows = readExtra(extraPath);
  for (let i = 0; i < Math.max(popular.length, trending.length); i++) rows.push(...[popular[i], trending[i]].filter((x): x is TitleRow => !!x));
  return rows;
}

const VERBS = ['assistir', 'assista', 'colocar', 'coloque', 'reproduzir', 'reproduza', 'abrir', 'abra', 'abre'];

/** Amostras do WatchIntent: o título vem de uma lista (slot próprio), então pode vir junto de app, temporada e episódio. */
export function watchSamples(): string[] {
  return VERBS.flatMap((v) => [
    `${v} {title}`,
    `${v} {title} na {app}`,
    `${v} {title} no {app}`,
    `${v} {title} temporada {season} episódio {episode}`,
    `${v} {title} temporada {season} episódio {episode} na {app}`,
    `${v} {title} temporada {season} episódio {episode} no {app}`,
  ]);
}

interface Model {
  interactionModel: { languageModel: { intents: { name: string; slots?: unknown[]; samples: string[] }[]; types: { name: string }[] } };
}

/** Coloca o tipo TITLE e o WatchIntent no modelo (troca os que já existirem). */
export function mergeModel(model: Model, titleType: ReturnType<typeof buildTitleType>): Model {
  const lm = model.interactionModel.languageModel;
  lm.types = [...lm.types.filter((t) => t.name !== 'TITLE'), titleType];
  lm.intents = [
    ...lm.intents.filter((i) => i.name !== 'WatchIntent'),
    {
      name: 'WatchIntent',
      slots: [
        { name: 'title', type: 'TITLE' },
        { name: 'app', type: 'APP' },
        { name: 'season', type: 'AMAZON.NUMBER' },
        { name: 'episode', type: 'AMAZON.NUMBER' },
      ],
      samples: watchSamples(),
    },
  ];
  return model;
}
