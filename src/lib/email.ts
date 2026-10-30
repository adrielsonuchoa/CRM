const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed && EMAIL_PATTERN.test(trimmed) ? trimmed : null;
}

// Link mailto: com assunto e corpo pre-preenchidos (abre o cliente de
// e-mail do usuario - nenhum envio sai do servidor). Retorna null quando o
// e-mail nao e valido, pra quem chama poder desabilitar o botao.
export function buildMailtoUrl(email: string | null | undefined, subject?: string | null, body?: string | null): string | null {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const params: string[] = [];
  if (subject?.trim()) params.push(`subject=${encodeURIComponent(subject.trim())}`);
  if (body?.trim()) params.push(`body=${encodeURIComponent(body.trim())}`);
  return `mailto:${normalized}${params.length ? `?${params.join('&')}` : ''}`;
}
