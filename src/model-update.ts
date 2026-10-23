import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { buildTitleType, collectTitles, mergeModel } from './titles';

const run = promisify(execFile);
const { SKILL_ID, TITLES_PACKAGES = 'prv,dnp', TITLES_PER_LIST = '100', ASK_PROFILE = 'default', AUTO_TITLES, DATA_DIR = 'data' } = process.env;

const BASE_MODEL = 'skill/interaction-model.json'; // frases da skill, vêm com a imagem
const EXTRA = 'skill/titles-extra.txt';
/** Modelo com a lista de títulos do dia; o /model.json serve este arquivo quando ele existe. */
export const MODEL_FILE = `${DATA_DIR}/interaction-model.json`;
const STATE_FILE = `${DATA_DIR}/titles-state.json`;
const WEEK = 7 * 24 * 3600 * 1000;

export interface TitlesState {
  at: string;
  hash: string;
  titles: number;
  /** true se o modelo foi enviado ao console da Alexa. */
  pushed: boolean;
  note: string;
}

export function readState(): TitlesState | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as TitlesState;
  } catch {
    return null;
  }
}

const ask = (...args: string[]) => run('ask', [...args, '-p', ASK_PROFILE], { timeout: 120_000 });

/** Espera o build do modelo (~30 s). Se for recusado, o console mantém o último que construiu com sucesso. */
async function waitForBuild(): Promise<string> {
  for (let i = 0; i < 18; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    // sem build em andamento a SMAPI devolve vazio; só interessa o que aparece depois do envio
    const out = (await ask('smapi', 'get-skill-status', '-s', SKILL_ID as string, '--resource', 'interactionModel')).stdout;
    const jsonStart = out.indexOf('{');
    if (jsonStart < 0) continue;
    const req = JSON.parse(out.slice(jsonStart))?.interactionModel?.['pt-BR']?.lastUpdateRequest;
    const steps: { status: string }[] = req?.buildDetails?.steps ?? [];
    if (steps.some((s) => s.status === 'FAILED') || req?.status === 'FAILED') return `build FALHOU: ${JSON.stringify(req?.errors ?? req?.buildDetails ?? '').slice(0, 300)}`;
    if (steps.length && steps.every((s) => s.status === 'SUCCEEDED')) return 'build concluído';
  }
  return 'build ainda em andamento depois de 3 min; confira no console';
}

/**
 * Busca a lista atual no JustWatch, grava o modelo e, se a lista mudou, envia ao console da Alexa pela SMAPI (ASK CLI)
 * e espera o build.
 */
export async function updateTitles(force = false): Promise<TitlesState> {
  const type = buildTitleType(await collectTitles(TITLES_PACKAGES.split(',').map((s) => s.trim()), Number(TITLES_PER_LIST), EXTRA));
  if (type.values.length < 20) throw new Error(`lista pequena demais (${type.values.length}); nada foi alterado`);
  const hash = createHash('sha1').update(JSON.stringify(type.values.map((v) => v.name))).digest('hex');
  const prev = readState();

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(MODEL_FILE, JSON.stringify(mergeModel(JSON.parse(readFileSync(BASE_MODEL, 'utf8')), type), null, 2));

  let pushed = false;
  let note: string;
  if (!force && prev?.pushed && prev.hash === hash) {
    pushed = true;
    note = 'sem mudanças desde o último envio';
  } else if (SKILL_ID && existsSync(`${process.env.HOME ?? '/root'}/.ask/cli_config`)) {
    await ask('smapi', 'set-interaction-model', '-s', SKILL_ID, '-g', 'development', '-l', 'pt-BR', '--interaction-model', `file:${MODEL_FILE}`);
    note = `enviado ao console da Alexa; ${await waitForBuild()}`;
    pushed = !note.includes('FALHOU');
  } else {
    note = 'modelo gerado, mas sem ASK CLI configurado (ou SKILL_ID): falta enviá-lo ao console';
  }
  const state: TitlesState = { at: new Date().toISOString(), hash, titles: type.values.length, pushed, note };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

/** Com AUTO_TITLES=1, atualiza ao iniciar (se faz mais de uma semana) e confere de novo a cada 24 h. */
export function scheduleTitleUpdates(): void {
  if (AUTO_TITLES !== '1') return;
  const tick = () => {
    const prev = readState();
    if (prev && Date.now() - Date.parse(prev.at) < WEEK) return;
    updateTitles()
      .then((s) => console.log('titles', s.titles, s.note))
      .catch((e) => console.error('titles', String(e)));
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 24 * 3600 * 1000).unref();
}
