import { createClient } from '@libsql/client';

async function migrate() {
  console.log('Migrando banco SQLite local...');
  const client = createClient({ url: 'file:sqlite.db' });

  try {
    await client.execute(`ALTER TABLE leads ADD COLUMN conversation_provider TEXT DEFAULT 'BROWSER';`);
    console.log('Coluna conversation_provider adicionada com sucesso.');
  } catch (err: any) {
    if (err.message?.includes('duplicate column')) {
      console.log('Coluna conversation_provider já existe.');
    } else {
      console.log('Nota (conversation_provider):', err.message);
    }
  }

  try {
    await client.execute(`ALTER TABLE leads ADD COLUMN meta_psid TEXT;`);
    console.log('Coluna meta_psid adicionada com sucesso.');
  } catch (err: any) {
    if (err.message?.includes('duplicate column')) {
      console.log('Coluna meta_psid já existe.');
    } else {
      console.log('Nota (meta_psid):', err.message);
    }
  }

  console.log('Migração do banco de dados concluída!');
  process.exit(0);
}

migrate();
