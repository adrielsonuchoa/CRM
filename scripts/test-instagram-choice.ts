import assert from 'node:assert/strict';
import { selectInstagramWinner } from '../src/lib/instagram-enrichment';

const candidateA = {
  profile: { username: 'sabor_dacentenario', displayName: 'Sabor da Centenário', bio: 'Restaurante e pizzaria em Maceió', category: 'Restaurante', followers: 1200, postsCount: 80 },
  score: 82,
  method: 'instagram_search',
  signals: ['name', 'segment', 'city'],
  contradictions: [],
};

const candidateB = {
  profile: { username: 'sabor_da_centenario', displayName: 'Sabor da Centenário', bio: 'Loja de roupas', category: 'Moda', followers: 500, postsCount: 40 },
  score: 76,
  method: 'instagram_search',
  signals: ['name'],
  contradictions: ['wrong_segment'],
};

const candidateC = {
  profile: { username: 'saborcentenario', displayName: 'Sabor Centenário', bio: 'Pizzaria em Recife', category: 'Pizzaria', followers: 1800, postsCount: 90 },
  score: 74,
  method: 'instagram_search',
  signals: ['name', 'segment'],
  contradictions: ['wrong_city'],
};

const result = selectInstagramWinner([candidateA, candidateB, candidateC]);
assert.equal(result?.profile.username, 'sabor_dacentenario');
console.log('instagram choice test passed');
