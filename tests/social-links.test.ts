import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSocialLinksFromHtml,
  getFacebookPageUrl,
  getInstagramUsername,
  getWhatsAppFromLink,
  isBrazilianMobile,
  socialLinksFromWebsiteUrl,
} from '@/lib/social-links';
import { parseCsv, parseCsvRecords } from '@/lib/csv';

test('getInstagramUsername', () => {
  assert.equal(getInstagramUsername('https://www.instagram.com/Pizzaria.Bella/?hl=pt'), 'pizzaria.bella');
  assert.equal(getInstagramUsername('@bar_do_ze'), 'bar_do_ze');
  assert.equal(getInstagramUsername('https://instagram.com/p/abc123'), null);
});

test('getFacebookPageUrl ignora links de compartilhar/pixel', () => {
  assert.equal(getFacebookPageUrl('https://pt-br.facebook.com/PizzariaBella/'), 'https://www.facebook.com/PizzariaBella');
  assert.equal(getFacebookPageUrl('https://www.facebook.com/profile.php?id=1000123'), 'https://www.facebook.com/profile.php?id=1000123');
  assert.equal(getFacebookPageUrl('https://www.facebook.com/sharer/sharer.php?u=x'), null);
  assert.equal(getFacebookPageUrl('https://www.facebook.com/tr?id=1'), null);
  assert.equal(getFacebookPageUrl('https://example.com/facebook'), null);
});

test('getWhatsAppFromLink e celular', () => {
  assert.equal(getWhatsAppFromLink('https://wa.me/5582999998888?text=oi'), '5582999998888');
  assert.equal(getWhatsAppFromLink('https://api.whatsapp.com/send?phone=82999998888'), '5582999998888');
  assert.equal(isBrazilianMobile('+55 82 99999-8888'), true);
  assert.equal(isBrazilianMobile('(82) 3221-0901'), false);
});

test('extractSocialLinksFromHtml', () => {
  const html = `
    <a href="https://www.facebook.com/sharer/sharer.php?u=x">compartilhar</a>
    <a href="https://www.facebook.com/PizzariaBella">Facebook</a>
    <a href="https://www.instagram.com/pizzariabella/">Insta</a>
    <a href="https://wa.me/5582999998888">Peça</a>
    <a href="mailto:contato@pizzariabella.com.br">e-mail</a>
    <img src="logo@2x.png">`;
  assert.deepEqual(extractSocialLinksFromHtml(html), {
    instagram: 'pizzariabella',
    facebook: 'https://www.facebook.com/PizzariaBella',
    whatsapp: '5582999998888',
    emails: ['contato@pizzariabella.com.br'],
  });
});

test('socialLinksFromWebsiteUrl quando o site e a rede social', () => {
  assert.deepEqual(socialLinksFromWebsiteUrl('https://instagram.com/barzinho'), { instagram: 'barzinho' });
  assert.deepEqual(socialLinksFromWebsiteUrl('https://facebook.com/barzinho'), { facebook: 'https://www.facebook.com/barzinho' });
  assert.deepEqual(socialLinksFromWebsiteUrl('https://barzinho.com.br'), {});
});

test('parseCsv: aspas, separador e quebra de linha dentro do campo', () => {
  const csv = 'title,open_hours,phone\r\n"Bar ""do"" Zé","{""seg"": [""8h-18h""],\n""ter"": []}",+55 82 3221-0901\nPizzaria,,\n';
  assert.deepEqual(parseCsv(csv), [
    ['title', 'open_hours', 'phone'],
    ['Bar "do" Zé', '{"seg": ["8h-18h"],\n"ter": []}', '+55 82 3221-0901'],
    ['Pizzaria', '', ''],
  ]);
  assert.equal(parseCsvRecords(csv)[0].title, 'Bar "do" Zé');
});
