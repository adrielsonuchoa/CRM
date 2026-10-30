const BR_COUNTRY_CODE = '55';

// Normaliza um telefone/whatsapp de lead pro formato internacional que o
// wa.me espera: só dígitos, com o 55 do Brasil na frente. Retorna null
// quando não dá pra reconhecer um número válido (evita gerar link quebrado).
export function normalizeWhatsAppNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;

  // Já veio com o 55 na frente (12 = fixo/8 dígitos, 13 = celular/9 dígitos).
  if (digits.startsWith(BR_COUNTRY_CODE) && (digits.length === 12 || digits.length === 13)) {
    return digits;
  }
  // Número local (DDD + fixo de 8 ou celular de 9 dígitos) - adiciona o 55.
  if (digits.length === 10 || digits.length === 11) {
    return `${BR_COUNTRY_CODE}${digits}`;
  }
  return null;
}

// Monta o link do WhatsApp, com o texto da mensagem (se houver) pré-preenchido.
// Usa web.whatsapp.com em vez de wa.me: o wa.me detecta o app do WhatsApp
// instalado e mostra uma tela intermediária perguntando se quer abrir pelo
// app ou pela web, em vez de ir direto pra conversa na aba já logada.
// Retorna null quando o número não é válido, pra quem chama poder
// desabilitar/ocultar o botão.
export function buildWhatsAppUrl(phone: string | null | undefined, message?: string | null): string | null {
  const normalized = normalizeWhatsAppNumber(phone);
  if (!normalized) return null;

  const trimmedMessage = message?.trim();
  const params = new URLSearchParams({ phone: normalized });
  if (trimmedMessage) params.set('text', trimmedMessage);
  return `https://web.whatsapp.com/send?${params.toString()}`;
}
