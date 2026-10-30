import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMailtoUrl, normalizeEmail } from '@/lib/email';
import { buildWhatsAppUrl, normalizeWhatsAppNumber } from '@/lib/phone';
import { hasVerifiableContact } from '@/lib/lead-contact';

test('normalizeWhatsAppNumber', () => {
  assert.equal(normalizeWhatsAppNumber('(82) 99999-8888'), '5582999998888');
  assert.equal(normalizeWhatsAppNumber('+55 82 3333-4444'), '558233334444');
  assert.equal(normalizeWhatsAppNumber('5582999998888'), '5582999998888');
  assert.equal(normalizeWhatsAppNumber('12345'), null);
  assert.equal(normalizeWhatsAppNumber(null), null);
});

test('buildWhatsAppUrl inclui a mensagem quando houver', () => {
  const url = buildWhatsAppUrl('82999998888', 'Olá, tudo bem?');
  assert.ok(url);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('phone'), '5582999998888');
  assert.equal(parsed.searchParams.get('text'), 'Olá, tudo bem?');
  assert.equal(buildWhatsAppUrl('abc'), null);
});

test('normalizeEmail / buildMailtoUrl', () => {
  assert.equal(normalizeEmail('  Contato@Restaurante.com.BR '), 'contato@restaurante.com.br');
  assert.equal(normalizeEmail('sem-arroba'), null);
  assert.equal(buildMailtoUrl('invalido'), null);
  assert.equal(buildMailtoUrl('a@b.com'), 'mailto:a@b.com');
  assert.equal(
    buildMailtoUrl('a@b.com', 'Bar & Cia', 'Olá!\nLinha 2'),
    'mailto:a@b.com?subject=Bar%20%26%20Cia&body=Ol%C3%A1!%0ALinha%202',
  );
});

test('hasVerifiableContact: Instagram aceito ou telefone valido', () => {
  assert.equal(hasVerifiableContact({ instagramUsername: 'bar', profileAccepted: true }), true);
  assert.equal(hasVerifiableContact({ instagramUsername: 'bar', profileAccepted: false }), false);
  assert.equal(hasVerifiableContact({ phone: '(82) 99999-8888' }), true);
  assert.equal(hasVerifiableContact({ phone: '123' }), false);
});
