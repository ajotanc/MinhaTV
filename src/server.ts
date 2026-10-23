import { existsSync, readFileSync } from 'node:fs';
import express, { type RequestHandler } from 'express';
import * as Alexa from 'ask-sdk-core';
import { ExpressAdapter } from 'ask-sdk-express-adapter';
import { appByName, apps, parseRequest } from './apps';
import { MODEL_FILE, readState, scheduleTitleUpdates, updateTitles } from './model-update';
import * as tv from './tv';

const { SKILL_ID, TEST_TOKEN, PORT = 3000 } = process.env;

/** Erro com a fala que a Alexa deve dizer. */
class SayError extends Error {
  constructor(public say: string) {
    super(say);
  }
}

// Id da entidade resolvida pelo modelo de interação (ex.: "netflix"), ou null se não reconheceu
const slotId = (h: Alexa.HandlerInput, name: string): string | null => {
  const r = Alexa.getSlot(h.requestEnvelope, name)?.resolutions?.resolutionsPerAuthority?.[0];
  return r?.status.code === 'ER_SUCCESS_MATCH' ? (r.values?.[0].value.id ?? null) : null;
};
const slotValue = (h: Alexa.HandlerInput, name: string) => Alexa.getSlotValue(h.requestEnvelope, name);

const DEADLINE_MS = 6500;

// Numa conversa aberta ("abrir minha t. v."), mantém a sessão e repete a pergunta uma vez ("Mais alguma coisa?"), o que dá
// ~16 s para o próximo comando em vez de ~8 s. Dito numa frase só ("peça à minha t. v. para ..."), a sessão termina.
const intent = (name: string, fn: (h: Alexa.HandlerInput) => Promise<string>): Alexa.RequestHandler => ({
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === name,
  async handle(h) {
    // A Alexa desiste de esperar em ~8 s ("a skill não forneceu uma resposta válida"). Com o Wi-Fi da TV oscilando o comando
    // pode demorar mais: passado o prazo a Alexa recebe uma fala genérica e o comando segue em segundo plano.
    const work = fn(h);
    work.catch((e) => console.error(String(e)));
    const say = await Promise.race([work, new Promise<string>((r) => setTimeout(() => r('Já estou cuidando disso.'), DEADLINE_MS))]);
    const open = !(h.requestEnvelope.session?.new ?? true);
    const r = h.responseBuilder.speak(say).withShouldEndSession(!open);
    return (open ? r.reprompt('Mais alguma coisa?') : r).getResponse();
  },
});

// Nome canônico da entidade resolvida (ex.: "The Boys" mesmo que a Alexa tenha ouvido o sinônimo), ou null
const slotName = (h: Alexa.HandlerInput, name: string): string | null => {
  const r = Alexa.getSlot(h.requestEnvelope, name)?.resolutions?.resolutionsPerAuthority?.[0];
  return r?.status.code === 'ER_SUCCESS_MATCH' ? (r.values?.[0].value.name ?? null) : null;
};

// "na Netflix", "no Prime Video"
const at = (id: string) => `${id === 'netflix' ? 'na' : 'no'} ${apps[id].name}`;

/** Abre o título (no app pedido ou no primeiro serviço da prioridade) e devolve a fala. */
async function watch(query: string, app?: string, ep?: { season: number; episode: number }): Promise<string> {
  const what = ep ? `${query}, temporada ${ep.season}, episódio ${ep.episode}` : query;
  const played = await tv.play(app, query, ep);
  if (!played) return `Não achei ${query} nos seus serviços.`;
  if (!played.exact) return `Não achei ${query} ${at(played.app)}, abri a busca.`;
  return `${played.app === 'spotify' ? 'Tocando' : 'Abrindo'} ${what} ${at(played.app)}.`;
}

const needApp = (h: Alexa.HandlerInput): string => {
  const id = slotId(h, 'app');
  if (!id) throw new SayError('Não conheci esse aplicativo.');
  return id;
};

const handlers: Alexa.RequestHandler[] = [
  // A Alexa avisa que a conversa acabou (silêncio ou "pare"); não há o que responder
  {
    canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'SessionEndedRequest',
    handle: (h) => h.responseBuilder.getResponse(),
  },
  {
    canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'LaunchRequest',
    handle: (h) => h.responseBuilder.speak('Pode falar. Por exemplo: assistir Matrix.').reprompt('O que você quer fazer na TV?').getResponse(),
  },
  intent('OpenAppIntent', async (h) => {
    const id = needApp(h);
    await tv.open(id);
    return `Abrindo ${apps[id].name}.`;
  }),
  intent('CloseAppIntent', async (h) => {
    const id = needApp(h);
    await tv.close(id);
    return `Fechando ${apps[id].name}.`;
  }),
  intent('SearchIntent', async (h) => {
    // "o filme Matrix" -> "Matrix"
    const raw = (slotValue(h, 'query') ?? '').replace(/^(?:o|a)\s+(?:filme|série|serie|música|musica)\s+/i, '');
    // "abrir netflix" pode cair aqui em vez de no OpenAppIntent
    const only = appByName(raw);
    if (only) {
      await tv.open(only);
      return `Abrindo ${apps[only].name}.`;
    }
    const { query, app, season, episode } = parseRequest(raw);
    return watch(query, app, season && episode ? { season, episode } : undefined);
  }),
  // Título que está na lista do modelo (src/titles.ts): a Alexa o reconhece melhor e ainda traz app, temporada e episódio em slots
  intent('WatchIntent', async (h) => {
    const title = slotName(h, 'title') ?? slotValue(h, 'title') ?? '';
    const season = Number(slotValue(h, 'season'));
    const episode = Number(slotValue(h, 'episode'));
    return watch(title, slotId(h, 'app') ?? undefined, season && episode ? { season, episode } : undefined);
  }),
  intent('SeekIntent', async (h) => {
    const dir = slotId(h, 'dir');
    if (!dir) return 'Não entendi o comando.';
    await tv.key(dir, slotValue(h, 'secs') ?? 10);
    return 'Ok.';
  }),
  intent('KeyIntent', async (h) => {
    const key = slotId(h, 'key');
    if (!key) return 'Não entendi. Diga, por exemplo: assistir Matrix, pausar ou aumentar o volume.';
    await tv.key(key, slotValue(h, 'times'));
    return 'Ok.';
  }),
  {
    canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && ['AMAZON.StopIntent', 'AMAZON.CancelIntent'].includes(Alexa.getIntentName(h.requestEnvelope)),
    handle: (h) => h.responseBuilder.speak('Até logo.').getResponse(),
  },
  {
    canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest',
    handle: (h) => h.responseBuilder.speak('Não entendi. Tente: assistir Matrix.').getResponse(),
  },
];

const skill = Alexa.SkillBuilders.custom()
  .addRequestHandlers(...handlers)
  .addRequestInterceptors({
    process(h) {
      const r = h.requestEnvelope.request;
      const heard = r.type === 'IntentRequest' ? `${r.intent.name} ${JSON.stringify(Object.fromEntries(Object.entries(r.intent.slots ?? {}).map(([k, v]) => [k, v.value])))}` : '';
      console.log('alexa', r.type, heard);
      const id = h.requestEnvelope.context.System.application.applicationId;
      if (SKILL_ID && id !== SKILL_ID) throw new Error(`skill id inválido: ${id}`);
    },
  })
  .addErrorHandlers({
    canHandle: () => true,
    handle(h, e) {
      console.error(e);
      const say =
        e instanceof SayError
          ? e.say
          : /não autorizou/.test(e.message)
            ? 'A TV pediu autorização do ADB. Aceite o aviso na tela da Mi Box.'
            : /TV não respondeu/.test(e.message)
              ? 'A TV não respondeu agora. Tente de novo em alguns segundos.'
              : /TV não encontrada/.test(e.message)
              ? 'Não encontrei a TV na rede. Ela está ligada?'
              : 'Não consegui falar com a TV.';
      return h.responseBuilder.speak(say).getResponse();
    },
  })
  .create();

interface CmdBody {
  action?: string;
  app?: string;
  q?: string;
  key?: string;
  times?: number;
  season?: number;
  episode?: number;
}

const auth: RequestHandler = (req, res, next) => {
  if (!TEST_TOKEN || req.get('x-token') !== TEST_TOKEN) {
    res.sendStatus(401);
    return;
  }
  next();
};

const app = express();
// ExpressAdapter valida assinatura e timestamp da Alexa
// O hostname do endpoint é só desta skill, então ela atende na raiz; /alexa fica por compatibilidade
app.post(['/', '/alexa'], new ExpressAdapter(skill, true, true).getRequestHandlers());

// O modelo de interação da skill (frases e lista de títulos), público e sem dados sensíveis: permite atualizar o console
// buscando daqui, em vez de colar arquivos grandes à mão.
app.get('/model.json', (_req, res) => {
  const file = existsSync(MODEL_FILE) ? MODEL_FILE : 'skill/interaction-model.json'; // o do dia, com a lista de títulos atualizada
  res.set('access-control-allow-origin', '*').type('json').send(readFileSync(file, 'utf8'));
});

// Estado da TV (conectada? acordada? último comando); com token porque pode disparar a varredura da rede
app.get('/health', auth, async (_req, res) => {
  try {
    res.json({ ...(await tv.status()), titles: readState() });
  } catch (e) {
    res.status(503).send(String((e as Error).message));
  }
});

// Teste sem Alexa: curl -H "x-token: $TEST_TOKEN" -d '{"action":"play","app":"netflix","q":"matrix"}' -H 'content-type: application/json' /cmd
// `play` sem app escolhe o serviço pela prioridade; com season/episode abre o episódio.
app.post('/cmd', auth, express.json(), async (req, res) => {
  const { action, app: id = '', q = '', key = '', times, season, episode } = req.body as CmdBody;
  try {
    if (action === 'open') await tv.open(id);
    else if (action === 'close') await tv.close(id);
    else if (action === 'search') await tv.search(id, q);
    else if (action === 'titles') {
      res.json(await updateTitles(true)); // atualiza a lista agora e envia ao console (leva ~1 min)
      return;
    } else if (action === 'focus') {
      res.send(await tv.focus());
      return;
    } else if (action === 'play') {
      res.json(await tv.play(id || undefined, q, season && episode ? { season, episode } : undefined));
      return;
    } else if (action === 'key') await tv.key(key, times);
    else {
      res.status(400).send('action inválida');
      return;
    }
    res.send('ok');
  } catch (e) {
    res.status(500).send(String((e as Error).message));
  }
});

app.listen(PORT, () => console.log(`alexa-mibox na porta ${PORT}`));
scheduleTitleUpdates();
