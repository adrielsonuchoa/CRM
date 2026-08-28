import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { leads, settings } from './schema';
import crypto from 'crypto';

const client = createClient({ url: 'file:sqlite.db' });
const db = drizzle(client);

async function seed() {
  console.log('Clearing old data...');
  await db.delete(leads);
  await db.delete(settings);

  console.log('Inserting settings...');
  await db.insert(settings).values({
    id: crypto.randomUUID(),
    name: 'Representante Autorizado',
    commercialName: 'Sirrus Maceió',
    city: 'Maceió',
    territory: 'Alagoas',
    representedCompany: 'Sirrus',
    role: 'Representante Comercial',
  });

  console.log('Inserting mock leads...');
  await db.insert(leads).values([
    {
      id: crypto.randomUUID(),
      businessName: 'Restaurante Mar Azul',
      instagramUsername: 'marazul_mcz',
      category: 'Restaurante',
      subcategory: 'Frutos do Mar',
      neighborhood: 'Ponta Verde',
      city: 'Maceió',
      state: 'AL',
      leadScore: 92,
      followers: 12500,
      instagramActive: true,
      hasDelivery: true,
      hasDiningRoom: true,
      hasWaiters: true,
      pipelineStage: 'NOVO',
      source: 'TEST_FIXTURE',
      notes: 'Opera com salão cheio aos finais de semana, faz delivery próprio.',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: crypto.randomUUID(),
      businessName: 'Pizzaria Central',
      instagramUsername: 'pizzariacentralmcz',
      category: 'Pizzaria',
      neighborhood: 'Jatiúca',
      city: 'Maceió',
      state: 'AL',
      leadScore: 85,
      followers: 8300,
      instagramActive: true,
      hasDelivery: true,
      hasDiningRoom: true,
      pipelineStage: 'QUALIFICADO',
      source: 'TEST_FIXTURE',
      painPoints: JSON.stringify(['DELIVERY', 'COMANDAS']),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: crypto.randomUUID(),
      businessName: 'Burger House',
      instagramUsername: 'burgerhouse_al',
      category: 'Hamburgueria',
      neighborhood: 'Farol',
      city: 'Maceió',
      state: 'AL',
      leadScore: 78,
      followers: 15200,
      instagramActive: true,
      hasDelivery: true,
      hasDiningRoom: false,
      pipelineStage: 'PRONTO PARA CONTATO',
      source: 'TEST_FIXTURE',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: crypto.randomUUID(),
      businessName: 'Café da Praça',
      instagramUsername: 'cafedapracamcz',
      category: 'Cafeteria',
      neighborhood: 'Pajuçara',
      city: 'Maceió',
      state: 'AL',
      leadScore: 65,
      followers: 4100,
      instagramActive: true,
      hasDelivery: false,
      hasDiningRoom: true,
      pipelineStage: 'PESQUISANDO',
      source: 'TEST_FIXTURE',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
  ]);

  console.log('Seed completed successfully!');
  client.close();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
