import { PNG } from 'pngjs';

/** Orientação da fila de avatares do seletor de perfil. */
export type Layout = 'vertical' | 'horizontal';

// Medido em capturas 1920x1080 e escalado pela altura. `at` é a posição (fração da largura/altura) da linha
// que passa pelo centro dos avatares; os tamanhos são o diâmetro (avatar em foco é maior) e o vão entre eles.
// `offsets` são linhas paralelas (px) lidas junto: fotos de avatar têm partes escuras e uma linha só quebraria o bloco.
const SPEC: Record<Layout, { at: number; offsets: number[]; min: number; max: number; gapMin: number; gapMax: number; flat?: number[] }> = {
  vertical: { at: 0.123, offsets: [0, -25, 25], min: 90, max: 170, gapMin: 15, gapMax: 50 }, // Prime
  // flat: linhas (fração da altura) que no seletor são só fundo liso; a tela inicial do Android tem uma fileira de apps
  // do mesmo tamanho dos avatares e só se distingue por ter imagem nessa região.
  horizontal: { at: 0.444, offsets: [0, -60, -30, 30, 60], min: 190, max: 270, gapMin: 15, gapMax: 70, flat: [0.27, 0.31] }, // Disney+
};

/**
 * Reconhece o seletor de perfil numa captura de tela (PNG): uma fila de avatares redondos. Percorre a linha que
 * passa pelo centro dos avatares e procura 3 blocos seguidos do tamanho de um avatar, separados por um vão
 * escuro. Isso não aparece na página inicial, no player, em anúncios nem em tela preta.
 * Captura vazia ou ilegível (vídeo protegido) vale como "não é o seletor".
 */
// shortcut: calibrado em pt-BR no Prime (vertical) e no Disney+ (horizontal); outros apps pedem nova medida.
export function isProfilePicker(png: Buffer, layout: Layout = 'vertical'): boolean {
  let img: PNG;
  try {
    img = PNG.sync.read(png);
  } catch {
    return false;
  }
  const s = img.height / 1080;
  const spec = SPEC[layout];
  const vertical = layout === 'vertical';
  const center = Math.round((vertical ? img.width : img.height) * spec.at);
  const length = vertical ? img.height : img.width;

  const runs: { start: number; end: number }[] = [];
  let start = -1;
  for (let t = 0; t <= length; t++) {
    let busy = false;
    for (const o of t < length ? spec.offsets : []) {
      const fixed = center + Math.round(o * s);
      const i = (vertical ? t * img.width + fixed : fixed * img.width + t) * 4;
      const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
      if (0.3 * r + 0.59 * g + 0.11 * b > 45 || Math.max(r, g, b) - Math.min(r, g, b) > 70) busy = true;
    }
    if (busy && start < 0) start = t;
    if (!busy && start >= 0) {
      // partes escuras de uma foto de avatar não podem partir o bloco em dois
      const prev = runs[runs.length - 1];
      if (prev && start - prev.end < 12 * s) prev.end = t;
      else runs.push({ start, end: t });
      start = -1;
    }
  }

  let chain = 0;
  let prevEnd = -Infinity;
  for (const r of runs) {
    const len = r.end - r.start;
    const avatar = len >= spec.min * s && len <= spec.max * s;
    const gap = r.start - prevEnd;
    chain = avatar ? (chain > 0 && gap >= spec.gapMin * s && gap <= spec.gapMax * s ? chain + 1 : 1) : 0;
    if (chain >= 3) return spec.flat ? spec.flat.every((f) => isFlat(img, Math.round(img.height * f))) : true;
    prevEnd = r.end;
  }
  return false;
}

// Linha de fundo liso e escuro (praticamente nenhum pixel claro ou colorido)
function isFlat(img: PNG, y: number): boolean {
  let flat = 0;
  let total = 0;
  for (let x = 0; x < img.width; x += 4, total++) {
    const i = (y * img.width + x) * 4;
    const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
    if (0.3 * r + 0.59 * g + 0.11 * b < 45 && Math.max(r, g, b) - Math.min(r, g, b) < 30) flat++;
  }
  return flat / total >= 0.98;
}
