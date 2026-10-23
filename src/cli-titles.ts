// Atualiza a lista de títulos do modelo da skill com os mais populares e em alta do JustWatch (uso manual, no PC).
// Uso: npm run titles   (TITLES_PACKAGES=prv,dnp  TITLES_PER_LIST=100)
// No container isso roda sozinho, e o envio ao console é feito por model-update.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildTitleType, collectTitles, mergeModel } from './titles';

const MODEL = 'skill/interaction-model.json';
const EXTRA = 'skill/titles-extra.txt';
const LIST = 'skill/titles.json';

async function main() {
  const packages = (process.env.TITLES_PACKAGES ?? 'prv,dnp').split(',').map((s) => s.trim());
  const type = buildTitleType(await collectTitles(packages, Number(process.env.TITLES_PER_LIST ?? 100), EXTRA));
  if (type.values.length < 20) throw new Error(`lista pequena demais (${type.values.length}); modelo não alterado`);
  writeFileSync(LIST, JSON.stringify({ updatedAt: new Date().toISOString(), packages, titles: type.values.map((v) => v.name.value) }, null, 2) + '\n');
  writeFileSync(MODEL, JSON.stringify(mergeModel(JSON.parse(readFileSync(MODEL, 'utf8')), type), null, 2) + '\n');
  console.log(`${type.values.length} títulos (${packages.join(', ')}) em ${MODEL}`);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
