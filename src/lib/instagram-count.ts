// Contadores do Instagram: "2.573" (milhar pt-BR), "2,573" (milhar en),
// "1,5 mil", "12,3 mi", "1 milhão", "1.5k", "2M". Antes "2.573" virava 2,573
// e era arredondado pra 3 seguidores.
export function parseCount(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const match = text.match(/^(\d[\d.,]*)\s*(.*)$/);
  if (!match) return null;
  const [, numberText, rest] = match;
  const multiplier = /^(milh|mi\b|m\b)/.test(rest) ? 1_000_000
    : /^(mil\b|k\b)/.test(rest) ? 1_000
    : /^b\b/.test(rest) ? 1_000_000_000
    : 1;

  let base: number;
  if (multiplier === 1 && /^\d{1,3}([.,]\d{3})+$/.test(numberText)) {
    // Sem sufixo e em grupos de 3: o separador e de milhar.
    base = Number(numberText.replace(/[.,]/g, ''));
  } else {
    base = parseFloat(numberText.replace(',', '.'));
  }
  if (Number.isNaN(base)) return null;
  return Math.round(base * multiplier);
}
