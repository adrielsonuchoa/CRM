import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApproachTemplate, findPersonalizationSignal } from '@/lib/approach-template';

test('modelo generico quando nao ha sinal do negocio', () => {
  const message = buildApproachTemplate({ businessName: 'Pizzaria Bella' });
  assert.match(message, /^Oi, Pizzaria Bella! Sou da Sirrus aqui em Maceió\./);
  assert.equal((message.match(/\?/g) ?? []).length, 1);
  assert.ok(message.endsWith('?'));
});

test('usa o sinal do negocio com concordancia no plural', () => {
  assert.equal(findPersonalizationSignal({ businessName: 'X', hasDelivery: true }), 'trabalham com delivery');
  assert.match(buildApproachTemplate({ businessName: 'X', hasDelivery: true }), /Sei que vocês trabalham com delivery/);
  assert.equal(findPersonalizationSignal({ businessName: 'X', notes: 'Faça sua reserva de mesa' }), 'trabalham com reservas');
  assert.equal(findPersonalizationSignal({ businessName: 'X', profileSnippet: 'Rodízio de pizza toda noite' }), 'trabalham com rodízio');
});

test('sem nome usa saudacao neutra', () => {
  assert.match(buildApproachTemplate({ businessName: '' }), /^Oi! /);
});
