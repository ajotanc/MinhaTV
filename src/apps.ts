import type { Layout } from './screen';
import { searchUrl } from './spotify';
import { watchUrl } from './youtube';

/** Número = espera em ms; string = keycode do Android. */
export type Step = number | string;

export interface AppInfo {
  name: string;
  pkg: string;
  /** Deep link de busca com {q}; null usa a busca global do Android TV. */
  search: string | null;
  /**
   * Fecha o app antes do link. Só a Netflix: ela ignora deep link com o app aberto (dado do projeto de referência, não medido aqui,
   * sem conta). Spotify, Prime e Disney+ aceitam o pedido novo com o app já aberto (testado), então não fecham.
   */
  forceStop?: boolean;
  /**
   * Orientação do seletor de perfil. Depois de abrir um link, a skill espera o seletor aparecer (reconhecido por
   * captura de tela), aperta `profileKeys` e então OK. Sem valor, não mexe no perfil. A tela não é detectável de
   * outro jeito: Netflix e Prime usam uma activity só e o dump de interface vem vazio.
   */
  profilePicker?: Layout;
  /**
   * O seletor aparece também com o app já aberto (Prime e Globoplay, medido). Sem isso a skill só procura o seletor quando o app
   * estava fechado; o Disney+ lembra o perfil enquanto aberto e a busca por captura de tela seria trabalho inútil.
   */
  profileEveryLaunch?: boolean;
  /**
   * Teclas antes do OK para o foco cair no perfil certo. Vazio: usa o que vier em foco (no Prime, o último
   * usado, e se outra pessoa usar outro perfil a próxima abertura cai nele). No Disney+ nada vem em foco: o
   * primeiro OK dá foco ao último perfil usado e o OK final o escolhe.
   */
  profileKeys?: string[];
  /**
   * Alternativa ao profilePicker para apps cujo seletor é uma activity própria (Globoplay): trecho do nome da activity,
   * lido do foco da janela, sem captura de tela. Ao aparecer, aperta profileKeys e OK.
   */
  profileActivity?: string;
  /** Ms de espera depois que o seletor aparece e antes das teclas, para apps cujo seletor demora a aceitar o OK (padrão 400). Com o app já aberto o seletor carrega mais rápido: usa-se no máximo 5000. */
  profileSettle?: number;
  /** Teclas depois de abrir um link ou a busca (ex.: tocar o primeiro resultado). */
  after?: Step[];
  /** Parâmetro acrescentado aos links de título do JustWatch (o Prime sem ele para na página de detalhes do episódio). */
  linkQuery?: string;
  /** Acha o conteúdo por API própria (em vez do JustWatch); devolve a URL a abrir ou null. */
  resolve?: (q: string) => Promise<string | null>;
}

export const apps: Record<string, AppInfo> = {
  netflix: { name: 'Netflix', pkg: 'com.netflix.ninja', forceStop: true, search: 'https://www.netflix.com/search?q={q}' }, // profilePicker: o detector de screen.ts foi calibrado só no Prime (sem conta Netflix para medir)
  prime: { name: 'Prime Video', pkg: 'com.amazon.amazonvideo.livingroom', search: 'https://app.primevideo.com/search?phrase={q}', profilePicker: 'vertical', profileEveryLaunch: true, linkQuery: 'autoplay=1' },
  disney: { name: 'Disney Plus', pkg: 'com.disney.disneyplus', search: null, profilePicker: 'horizontal', profileKeys: ['KEYCODE_DPAD_CENTER'] },
  youtube: { name: 'YouTube', pkg: 'com.google.android.youtube.tv', search: 'vnd.youtube://results?search_query={q}', resolve: watchUrl },
  // after: calibrar na TV para tocar o primeiro resultado da busca
  spotify: { name: 'Spotify', pkg: 'com.spotify.tv.android', search: 'spotify:search:{q}', resolve: searchUrl },
  globoplay: { name: 'Globoplay', pkg: 'com.globo.globotv', search: null, profileActivity: 'AccountChooserActivity', profileSettle: 15000, profileEveryLaunch: true },
  max: { name: 'Max', pkg: 'com.wbd.stream', search: null },
};

/** "Matrix na Netflix" -> { query: "Matrix", app: "netflix" }; o Alexa às vezes engole o app na busca. */
// shortcut: só reconhece o nome do app ou o id exatos no fim da frase.
export function splitApp(text: string): { query: string; app?: string } {
  for (const [id, a] of Object.entries(apps)) {
    for (const n of [a.name, id]) {
      const m = text.match(new RegExp(`^(.+)\\s+(?:na|no)\\s+${n}$`, 'i'));
      if (m) return { query: m[1], app: id };
    }
  }
  return { query: text };
}

const NUMBERS: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, três: 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12 };
const toNumber = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUMBERS[s.toLowerCase()]);

/** O app, se o texto for só o nome dele ("netflix", "prime video"). */
export function appByName(text: string): string | undefined {
  const t = text.trim().toLowerCase();
  return Object.entries(apps).find(([id, a]) => t === id || t === a.name.toLowerCase())?.[0];
}

export interface Request {
  query: string;
  app?: string;
  season?: number;
  episode?: number;
}

/**
 * Lê o texto livre da Alexa ("The Boys temporada 1 episódio 2 na Prime Video"). A Alexa não aceita outro slot numa amostra
 * com AMAZON.SearchQuery, então o app, a temporada e o episódio vêm do próprio texto, em qualquer ordem entre os dois.
 */
// shortcut: temporada e episódio só no formato "temporada N episódio M" (N e M em dígitos ou por extenso até doze).
export function parseRequest(text: string): Request {
  let query = text.trim();
  const out: Request = { query };
  for (let i = 0; i < 2; i++) {
    const s = splitApp(query);
    if (s.app && !out.app) out.app = s.app;
    query = s.query;
    const m = query.match(/^(.+?)\s+temporada\s+(\S+)\s+epis[óo]dio\s+(\S+)$/i);
    if (m && out.season === undefined && toNumber(m[2]) && toNumber(m[3])) {
      out.season = toNumber(m[2]);
      out.episode = toNumber(m[3]);
      query = m[1];
    }
  }
  out.query = query;
  return out;
}
