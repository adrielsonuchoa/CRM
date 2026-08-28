import { getWorkerStatus, checkChromeConnection } from '../src/lib/browser-worker';
import { getMetaApiStatusConfig, testMetaConnection } from '../src/lib/meta-api';

async function runAutomationTests() {
  console.log('🧪 Iniciando Suíte de Testes do Sirrus CRM Automation...\n');
  let failures = 0;

  // 1. Worker Status Test
  try {
    const status = await getWorkerStatus();
    console.log('✅ Teste 1: Leitura de Status do Browser Worker ok:', {
      status: status.status,
      sentToday: status.sentToday,
      dailyLimit: status.dailyLimit,
    });
  } catch (err: any) {
    console.error('❌ Teste 1 falhou:', err.message);
    failures++;
  }

  // 2. CDP Connection Test (Safe fallback)
  try {
    const cdpRes = await checkChromeConnection();
    console.log('✅ Teste 2: Teste de Conexão Chrome CDP executado:', {
      connected: cdpRes.connected,
      profile: cdpRes.username,
    });
  } catch (err: any) {
    console.error('❌ Teste 2 falhou:', err.message);
    failures++;
  }

  // 3. Meta API Config Test
  try {
    const metaConfig = getMetaApiStatusConfig();
    console.log('✅ Teste 3: Leitura de Configurações da Meta API ok:', metaConfig);
  } catch (err: any) {
    console.error('❌ Teste 3 falhou:', err.message);
    failures++;
  }

  // 4. Meta Token Test
  try {
    const metaTest = await testMetaConnection();
    console.log('✅ Teste 4: Verificação da Meta API executada sem estouro de exceção:', {
      status: metaTest.status,
      message: metaTest.message,
    });
  } catch (err: any) {
    console.error('❌ Teste 4 falhou:', err.message);
    failures++;
  }

  console.log('\n----------------------------------------');
  if (failures === 0) {
    console.log('🎉 Todos os testes de automação passaram com Sucesso!');
    process.exit(0);
  } else {
    console.error(`💥 ${failures} teste(s) falharam.`);
    process.exit(1);
  }
}

runAutomationTests();
