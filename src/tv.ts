import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import { apps, type AppInfo, type Step } from './apps';
import { findLinks, type Episode, type Links } from './justwatch';
import { isProfilePicker } from './screen';

const run = promisify(execFile);
const { TV_SUBNET = '192.168.1.0/24', TV_MODEL, SERVICE_PRIORITY = 'netflix,prime,disney,globoplay,max' } = process.env;
const PRIORITY = SERVICE_PRIORITY.split(',').map((s) => s.trim());
let host = process.env.TV_HOST; // ex.: 192.168.1.50:5555; opcional, se faltar ou falhar a rede é varrida
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** id -> [keycode, repetições padrão, segundos por toque, true se o 1º toque só abre a barra (só nos avanços)] */
const KEYS: Record<string, [code: string, repeat: number, unit?: number, opensBar?: boolean]> = {
  volume_up: ['KEYCODE_VOLUME_UP', 2],
  volume_down: ['KEYCODE_VOLUME_DOWN', 2],
  mute: ['KEYCODE_VOLUME_MUTE', 1],
  play_pause: ['KEYCODE_MEDIA_PLAY_PAUSE', 1],
  // Separadas para que "pausar" duas vezes não volte a tocar
  pause: ['KEYCODE_MEDIA_PAUSE', 1],
  play: ['KEYCODE_MEDIA_PLAY', 1],
  home: ['KEYCODE_HOME', 1],
  back: ['KEYCODE_BACK', 1],
  select: ['KEYCODE_DPAD_CENTER', 1],
  up: ['KEYCODE_DPAD_UP', 1],
  down: ['KEYCODE_DPAD_DOWN', 1],
  left: ['KEYCODE_DPAD_LEFT', 1],
  right: ['KEYCODE_DPAD_RIGHT', 1],
  sleep: ['KEYCODE_SLEEP', 1],
  wake: ['KEYCODE_WAKEUP', 1],
  // Teclas de mídia, não setas: com os controles na tela as setas só movem o foco (no YouTube chegam em "Não gostei").
  // Medido no YouTube: 10 s por toque, mas toques mandados juntos num comando só são colados e contam poucos (3 ou 4
  // seguidos deram +20 s). Por isso vai um toque por comando, e o primeiro, que só abre a barra, vem antes.
  // shortcut: com a barra já aberta (dois comandos seguidos) sai 10 s a mais; conferir Prime e Disney+.
  seek_back: ['KEYCODE_MEDIA_REWIND', 1, 10, true],
  seek_forward: ['KEYCODE_MEDIA_FAST_FORWARD', 1, 10, true],
};

const portOpen = (ip: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createConnection({ host: ip, port, timeout: 600 });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('timeout', () => (s.destroy(), resolve(false)));
    s.once('error', () => resolve(false));
  });

const UNAUTHORIZED = 'TV não autorizou o ADB: aceite o aviso "Permitir depuração" na tela da Mi Box';

type Conn = 'ok' | 'unauthorized' | 'down';

const adbConnect = (h: string): Promise<Conn> =>
  run('adb', ['connect', h], { timeout: 3500 }).then(
    (r) => (/connected to/.test(r.stdout) ? 'ok' : /failed to authenticate/.test(r.stdout) ? 'unauthorized' : 'down'), // "connected to" cobre "already connected to"
    (): Conn => 'down'
  );

// Varre a sub-rede atrás de quem responde na porta do ADB e confere o modelo (TV_MODEL, se definido).
// shortcut: só /24 (usa os 3 primeiros octetos); redes maiores exigem outro laço.
async function discover(): Promise<string> {
  const base = TV_SUBNET.split('.').slice(0, 3).join('.');
  const ips = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
  const open = (await Promise.all(ips.map(async (ip) => ((await portOpen(ip, 5555)) ? ip : null)))).filter((ip): ip is string => !!ip);
  let unauthorized = false;
  for (const ip of open) {
    const h = `${ip}:5555`;
    const conn = await adbConnect(h);
    if (conn === 'unauthorized') unauthorized = true;
    if (conn !== 'ok') continue;
    const model = await run('adb', ['-s', h, 'shell', 'getprop ro.product.model'], { timeout: 8000 }).then((r) => r.stdout.trim(), () => '');
    if (!TV_MODEL || model.toLowerCase().includes(TV_MODEL.toLowerCase())) {
      console.log(`TV encontrada em ${h} (${model})`);
      return h;
    }
  }
  throw new Error(unauthorized ? UNAUTHORIZED : `TV não encontrada em ${TV_SUBNET}`);
}

let finding: Promise<string> | null = null;

const NOT_RESPONDING = 'TV não respondeu: tente de novo em alguns segundos';

// connect é idempotente. A TV às vezes fica sem responder por instantes (visto pausada e depois de fechar um app); se o IP
// mudou ela também não responde. Em vez de esperar a varredura da rede (~10 s, mais do que a Alexa espera), falha logo e
// procura a TV em segundo plano, para o próximo comando já achá-la.
async function connect(): Promise<string> {
  for (let i = 0; host && i < 2; i++) {
    const conn = await adbConnect(host);
    if (conn === 'ok') return host;
    if (conn === 'unauthorized') throw new Error(UNAUTHORIZED);
    await sleep(500);
  }
  finding ??= discover()
    .then((h) => (host = h))
    .finally(() => (finding = null));
  if (!host) return finding; // sem IP configurado não há o que tentar: espera a varredura
  finding.catch((e) => console.error(String(e)));
  throw new Error(NOT_RESPONDING);
}

// A Mi Box ociosa deixa o Wi-Fi dormir (medido: 10% de pacotes perdidos e picos de 560 ms), e o primeiro comando depois
// disso falha. Um toque leve a cada 20 s mantém o ADB e o Wi-Fi acordados; se a TV sumir, também dispara a busca em segundo plano.
setInterval(() => {
  connect()
    .then((h) => run('adb', ['-s', h, 'shell', 'true'], { timeout: 5000 }))
    .catch(() => undefined);
}, 20_000).unref();

/** Último comando enviado ao ADB, para o /health. */
const last = { cmd: '', at: 0 };

async function sh(cmd: string): Promise<string> {
  const h = await connect();
  console.log('adb', cmd);
  last.cmd = cmd;
  last.at = Date.now();
  const shell = () => run('adb', ['-s', h, 'shell', cmd], { timeout: 8000 });
  // Logo depois de iniciar o ADB (restart do container) a TV leva alguns segundos para validar a chave
  const { stdout } = await shell().catch(async (e: Error) => {
    if (!/still authorizing|offline/.test(e.message)) throw e;
    await sleep(2500);
    return shell();
  });
  return stdout;
}

function getApp(id: string): AppInfo {
  const app = apps[id];
  if (!app) throw new Error(`app desconhecido: ${id}`);
  return app;
}

// Roda em segundo plano para não estourar o timeout de 8s da Alexa
function runSteps(steps: Step[] = []): void {
  (async () => {
    for (const s of steps) typeof s === 'number' ? await sleep(s) : await sh(`input keyevent ${s}`);
  })().catch(console.error);
}

/** Janela em foco, ex.: "mCurrentFocus=Window{... com.netflix.ninja/com.netflix.ninja.MainActivity}". */
export const focus = () => sh('dumpsys window | grep mCurrentFocus');

const isAwake = async () => (await sh('dumpsys power | grep mWakefulness')).includes('Awake');

/** Estado para o /health. */
export async function status() {
  const h = await connect();
  return { host: h, awake: await isAwake(), lastCommand: last.cmd, lastAt: last.at ? new Date(last.at).toISOString() : null };
}

// Acorda a TV se estiver em standby; comandos de app não funcionam com ela dormindo
async function wake(): Promise<void> {
  if (!(await isAwake())) {
    await sh('input keyevent KEYCODE_WAKEUP');
    await sleep(3000);
  }
}

// Captura de tela em memória (nada é gravado em disco)
async function screenshot(): Promise<Buffer> {
  const h = await connect();
  const { stdout } = await run('adb', ['-s', h, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 8000 });
  return stdout;
}

// Espera o seletor de perfil aparecer (por captura de tela) e aperta OK uma única vez no perfil em foco (o último usado).
// Só age com o seletor visível: a tecla em outra tela cairia em botões de anúncio ("Enviar para o telefone").
function pickProfile(a: AppInfo, warm: boolean): void {
  (async () => {
    // 1 s entre capturas: a Mi Box tem 2 GB de RAM e cada captura custa CPU
    for (const until = Date.now() + 25_000; Date.now() < until; await sleep(1000)) {
      const ready = a.profileActivity
        ? (await focus()).includes(a.profileActivity)
        : !!a.profilePicker && isProfilePicker(await screenshot(), a.profilePicker);
      if (!ready) continue;
      await sleep(Math.min(a.profileSettle ?? 400, warm ? 5000 : Infinity)); // deixa o seletor carregar e o foco assentar
      if (a.profileKeys?.length) {
        await sh(`input keyevent ${a.profileKeys.join(' ')}`);
        await sleep(400);
      }
      await sh('input keyevent KEYCODE_DPAD_CENTER');
      return;
    }
    console.error(`seletor de perfil não apareceu em ${a.name}`);
  })().catch(console.error);
}

export async function open(id: string): Promise<void> {
  const { pkg } = getApp(id);
  await wake();
  const out = await sh(`monkey -p ${pkg} -c android.intent.category.LEANBACK_LAUNCHER 1`);
  if (/No activities found/.test(out)) await sh(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
}

// HOME antes: force-stop do app em primeiro plano dá NullPointerException no ActivityManager da Mi Box (Android 9).
// O erro vem depois de matar o processo, então é só registrado.
async function stop(pkg: string): Promise<void> {
  await sh('input keyevent KEYCODE_HOME');
  await sleep(500);
  await sh(`am force-stop ${pkg}`).catch(console.error);
}

export const close = (id: string) => stop(getApp(id).pkg);

export async function search(id: string, text: string): Promise<void> {
  const a = getApp(id);
  await wake();
  // shortcut: sem deep link de busca cai na busca global do Android TV, ajustar em apps.ts
  await sh(
    a.search
      ? `am start -a android.intent.action.VIEW -d ${quote(a.search.replace('{q}', encodeURIComponent(text)))} -p ${a.pkg}`
      : `am start -a android.search.action.GLOBAL_SEARCH -e query ${quote(text)}`
  );
  runSteps(a.after);
}

async function launch(a: AppInfo, link: string): Promise<void> {
  if (a.forceStop) {
    await stop(a.pkg);
    await sleep(1500);
  }
  // App já aberto: o pedido novo só troca o conteúdo, e o seletor de perfil só reaparece nos apps que o mostram sempre
  const wasRunning = await sh(`pidof ${a.pkg}`).then((o) => o.trim() !== '', () => false);
  // Links do JustWatch são intents completos, mas alguns (Disney+) vêm sem pacote e o Android pergunta "Abrir com"
  // entre o app e o navegador; os das APIs próprias são URLs para o app abrir.
  // O component do JustWatch vem de outro aparelho (no Globoplay é uma activity que não existe na versão de TV), então sai.
  const noComponent = link.replace(/;component=[^;]*/, '');
  const withPkg = /;package=/.test(noComponent) ? noComponent : noComponent.replace(/;end$/, `;package=${a.pkg};end`);
  const intent = a.linkQuery ? withPkg.replace('#Intent', `${withPkg.includes('?') ? '&' : '?'}${a.linkQuery}#Intent`) : withPkg;
  await sh(link.startsWith('intent:') ? `am start ${quote(intent)}` : `am start -a android.intent.action.VIEW -d ${quote(link)} -p ${a.pkg}`);
  if ((a.profilePicker || a.profileActivity) && (a.profileEveryLaunch || !wasRunning)) pickProfile(a, wasRunning);
  runSteps(a.after);
}

const safe = <T>(p: Promise<T>, fallback: T) => p.catch((e) => (console.error(e), fallback));

export interface Played {
  app: string;
  /** false: não achou o título e só abriu a busca do app. */
  exact: boolean;
}

/**
 * Abre o título. Com `id`, no app pedido (YouTube e Spotify usam API própria, o resto o JustWatch);
 * sem `id`, no primeiro serviço de SERVICE_PRIORITY que tiver o título. Null se não achou em nenhum.
 */
export async function play(id: string | undefined, text: string, ep?: Episode): Promise<Played | null> {
  await wake();
  if (id) {
    const a = getApp(id);
    const link = a.resolve ? await safe(a.resolve(text), null) : (await safe(findLinks(text, ep), {} as Links))[id];
    if (!link) {
      await search(id, text);
      return { app: id, exact: false };
    }
    await launch(a, link);
    return { app: id, exact: true };
  }
  const found = await safe(findLinks(text, ep), {} as Links);
  const app = PRIORITY.find((s) => found[s]);
  if (!app) return null;
  await launch(getApp(app), found[app]);
  return { app, exact: true };
}

/** Quantos toques mandar (além do que abre a barra). `times`: repetições (ou segundos, nas teclas de avançar/voltar). */
export function presses(id: string, times?: string | number): number {
  const k = KEYS[id];
  if (!k) throw new Error(`tecla desconhecida: ${id}`);
  const t = Number(times);
  return Math.min(Math.max(t ? Math.ceil(t / (k[2] ?? 1)) : k[1], 1), 30);
}

export async function key(id: string, times?: string | number): Promise<void> {
  const n = presses(id, times);
  const [code, , , opensBar] = KEYS[id];
  if (!opensBar) {
    await sh(`input keyevent ${Array(n).fill(code).join(' ')}`);
    return;
  }
  await sh(`input keyevent ${code}`); // só abre a barra
  await sleep(700);
  for (let i = 0; i < n; i++) await sh(`input keyevent ${code}`);
}
