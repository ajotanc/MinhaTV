import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { appByName, parseRequest, splitApp } from './apps';
import { isProfilePicker } from './screen';
import { presses } from './tv';
import { buildTitleType, mergeModel, watchSamples } from './titles';
import { pick, seconds } from './youtube';
import { bestLinks, type Offer } from './justwatch';

test('splitApp separa o app no fim da frase', () => {
  assert.deepEqual(splitApp('Matrix na Netflix'), { query: 'Matrix', app: 'netflix' });
  assert.deepEqual(splitApp('Round 6 no prime video'), { query: 'Round 6', app: 'prime' });
  assert.deepEqual(splitApp('A Casa do Dragão'), { query: 'A Casa do Dragão' });
});

test('bestLinks reconhece planos com anúncios e prefere assinatura', () => {
  const offer = (clearName: string, monetizationType: string, deeplinkURL: string): Offer => ({ monetizationType, package: { clearName }, deeplinkURL });
  const links = bestLinks([
    offer('Amazon Video', 'RENT', 'rent'),
    offer('Amazon Prime Video with Ads', 'FLATRATE', 'flat'),
    offer('Netflix Standard with Ads', 'FLATRATE', 'nflx'),
    offer('Outro', 'FLATRATE', 'x'),
  ]);
  assert.deepEqual(links, { prime: 'flat', netflix: 'nflx' });
});

// PNG 1920x1080 de fundo escuro com blocos claros [y, altura] na coluna dos avatares (x 187..287)
function screen(blocks: [number, number][]): Buffer {
  const png = new PNG({ width: 1920, height: 1080 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([0, 5, 20, 255], i);
  for (const [y, h] of blocks) for (let yy = y; yy < y + h; yy++) for (let x = 187; x <= 287; x++) png.data.set([200, 90, 20, 255], (yy * 1920 + x) * 4);
  return PNG.sync.write(png);
}

test('isProfilePicker reconhece a pilha de avatares, com ou sem foco', () => {
  assert.equal(isProfilePicker(screen([[244, 100], [374, 100], [504, 100], [634, 100]])), true);
  assert.equal(isProfilePicker(screen([[182, 162], [374, 100], [504, 100]])), true); // avatar em foco é maior
});

test('isProfilePicker ignora tela preta, texto e blocos sem o espaçamento dos avatares', () => {
  assert.equal(isProfilePicker(screen([])), false);
  assert.equal(isProfilePicker(screen([[158, 14], [289, 67], [610, 55]])), false); // página inicial
  assert.equal(isProfilePicker(screen([[244, 100], [440, 100], [640, 100]])), false); // vão grande demais
});

// Fila horizontal (Disney+): blocos claros [x, largura] na linha dos avatares (y 380..580)
function screenH(blocks: [number, number][]): Buffer {
  const png = new PNG({ width: 1920, height: 1080 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([27, 27, 32, 255], i);
  for (const [x, w] of blocks) for (let xx = x; xx < x + w; xx++) for (let y = 380; y < 580; y++) png.data.set([200, 90, 20, 255], (y * 1920 + xx) * 4);
  return PNG.sync.write(png);
}

test('isProfilePicker horizontal reconhece a fila de avatares e ignora o resto', () => {
  assert.equal(isProfilePicker(screenH([[246, 203], [491, 203], [736, 203], [981, 203]]), 'horizontal'), true);
  assert.equal(isProfilePicker(screenH([[226, 245], [491, 203], [736, 203]]), 'horizontal'), true); // em foco
  assert.equal(isProfilePicker(screenH([]), 'horizontal'), false);
  assert.equal(isProfilePicker(screenH([[246, 203], [700, 203], [1200, 203]]), 'horizontal'), false); // vão grande
  assert.equal(isProfilePicker(screenH([[246, 203], [491, 203], [736, 203]])), false); // layout vertical não vê fila horizontal
});

test('isProfilePicker trata captura vazia (vídeo protegido) como "não é o seletor"', () => {
  assert.equal(isProfilePicker(Buffer.alloc(0), 'horizontal'), false);
});

test('seconds lê a duração ISO 8601 do YouTube', () => {
  assert.equal(seconds('PT1H2M3S'), 3723);
  assert.equal(seconds('PT4M13S'), 253);
  assert.equal(seconds('PT45S'), 45);
  assert.equal(seconds('P0D'), 0); // ao vivo
});

test('pick evita Shorts e compilações longas, salvo se o pedido pede', () => {
  const d = { short: 30, hora: 3700, clipe: 355, outro: 200 };
  assert.equal(pick(['short', 'hora', 'clipe', 'outro'], d, 'queen clipe oficial'), 'clipe');
  assert.equal(pick(['short', 'hora', 'clipe'], d, 'queen 1 hour'), 'hora'); // pediu longo
  assert.equal(pick(['short', 'hora'], d, 'qualquer coisa'), 'short'); // nada serve: cai no primeiro
  assert.equal(pick(['a', 'b'], {}, 'sem durações'), 'a');
});

test('presses: avançar conta 10 s por toque e o volume usa a contagem pedida', () => {
  assert.equal(presses('seek_forward', 30), 3);
  assert.equal(presses('seek_back', 10), 1);
  assert.equal(presses('volume_up'), 2); // padrão
  assert.equal(presses('volume_up', 4), 4);
  assert.equal(presses('volume_up', 99), 30); // teto
  assert.throws(() => presses('nada'));
});

test('parseRequest tira o app, a temporada e o episódio do texto livre da Alexa', () => {
  assert.deepEqual(parseRequest('The Boys temporada 1 episódio 2 na Prime Video'), { query: 'The Boys', app: 'prime', season: 1, episode: 2 });
  assert.deepEqual(parseRequest('The Boys na Prime Video temporada um episódio dois'), { query: 'The Boys', app: 'prime', season: 1, episode: 2 });
  assert.deepEqual(parseRequest('Stranger Things temporada 2 episódio 3'), { query: 'Stranger Things', season: 2, episode: 3 });
  assert.deepEqual(parseRequest('Matrix no Disney Plus'), { query: 'Matrix', app: 'disney' });
  assert.deepEqual(parseRequest('Matrix'), { query: 'Matrix' });
  assert.deepEqual(parseRequest('temporada de ouro'), { query: 'temporada de ouro' }); // sem número: não é episódio
});

test('appByName reconhece só o nome do app', () => {
  assert.equal(appByName('Netflix'), 'netflix');
  assert.equal(appByName('prime video'), 'prime');
  assert.equal(appByName('Matrix'), undefined);
});

test('buildTitleType usa o nome em português, põe o original como sinônimo e não repete nada', () => {
  const t = buildTitleType([
    { pt: 'Os Rapazes', en: 'The Boys' },
    { pt: 'The Boys', en: 'The Boys' }, // pt igual ao original de outro: não pode virar valor repetido
    { pt: '  Round   6 ', en: 'Round 6' }, // espaços sobrando
    { pt: 'Duna: Parte {2}', en: 'Dune: Part Two' }, // símbolos que o slot recusa
    { pt: 'X' }, // curto demais
    { pt: 'os rapazes' }, // repetido (sem diferenciar maiúsculas)
  ]);
  assert.deepEqual(t.values.map((v) => v.name.value), ['Os Rapazes', 'Round 6', 'Duna: Parte 2'.replace('2', ' 2 ').replace(/\s+/g, ' ').trim()]);
  assert.deepEqual(t.values[0].name.synonyms, ['The Boys']);
  assert.equal(new Set(t.values.map((v) => v.id)).size, t.values.length);
});

test('mergeModel coloca o tipo TITLE e o WatchIntent, e troca os antigos em vez de duplicar', () => {
  const model = { interactionModel: { languageModel: { intents: [{ name: 'SearchIntent', samples: [] }], types: [{ name: 'APP' }] } } };
  const once = mergeModel(model, buildTitleType([{ pt: 'Matrix' }]));
  const twice = mergeModel(once, buildTitleType([{ pt: 'Matrix' }, { pt: 'Duna' }]));
  const lm = twice.interactionModel.languageModel;
  assert.equal(lm.intents.filter((i) => i.name === 'WatchIntent').length, 1);
  assert.equal(lm.types.filter((x) => x.name === 'TITLE').length, 1);
  assert.ok(watchSamples().includes('assistir {title} temporada {season} episódio {episode} no {app}'));
});
