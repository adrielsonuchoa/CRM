// Catálogo de permissões do CRM. Toda chave aqui corresponde a uma ação real
// já existente no sistema (auditado em app/actions.ts, app/actions/ai.ts,
// app/settings/actions.ts e app/settings/actions-automation.ts) — não existe
// permissão pra funcionalidade que não existe.
export type PermissionKey =
  | 'DASHBOARD_VIEW'
  | 'LEAD_VIEW'
  | 'LEAD_UPDATE_STAGE'
  | 'LEAD_UPDATE_NOTES'
  | 'LEAD_MARK_DO_NOT_CONTACT'
  | 'LEAD_MARK_SENT'
  | 'LEAD_ENRICH'
  | 'LEAD_DELETE_ALL'
  | 'VIEW_ALL_LEADS'
  | 'AI_ANALYZE_LEAD'
  | 'AI_GENERATE_MESSAGE'
  | 'INSTAGRAM_SEND_MESSAGE'
  | 'INSTAGRAM_CANCEL_DM'
  | 'INSTAGRAM_PREVIEW_PROFILE'
  | 'AUTOMATION_START'
  | 'AUTOMATION_PAUSE'
  | 'AUTOMATION_TEST_CONNECTION'
  | 'SETTINGS_VIEW'
  | 'SETTINGS_EDIT'
  | 'LEADS_IMPORT_CSV'
  | 'INTEGRATION_TEST_META'
  | 'USERS_VIEW'
  | 'USERS_MANAGE'
  | 'AUDIT_LOG_VIEW';

export type PermissionGroup = {
  category: string;
  permissions: { key: PermissionKey; label: string; description?: string; highRisk?: boolean }[];
};

export const PERMISSION_CATALOG: PermissionGroup[] = [
  {
    category: 'Dashboard',
    permissions: [
      { key: 'DASHBOARD_VIEW', label: 'Visualizar dashboard' },
    ],
  },
  {
    category: 'Leads',
    permissions: [
      { key: 'LEAD_VIEW', label: 'Visualizar leads' },
      { key: 'LEAD_UPDATE_STAGE', label: 'Mover lead no pipeline / alterar estágio' },
      { key: 'LEAD_UPDATE_NOTES', label: 'Adicionar notas' },
      { key: 'LEAD_MARK_DO_NOT_CONTACT', label: 'Marcar como "Não Contatar"' },
      { key: 'LEAD_MARK_SENT', label: 'Marcar mensagem como enviada' },
      { key: 'LEAD_ENRICH', label: 'Buscar Instagram / enriquecer lead' },
      { key: 'VIEW_ALL_LEADS', label: 'Ver leads de todos os vendedores', description: 'Sem essa permissão, o usuário só vê os leads atribuídos a ele.' },
      { key: 'LEAD_DELETE_ALL', label: 'Limpar todos os leads', description: 'Ação destrutiva e irreversível.', highRisk: true },
    ],
  },
  {
    category: 'Mensagens / IA',
    permissions: [
      { key: 'AI_ANALYZE_LEAD', label: 'Analisar lead com IA' },
      { key: 'AI_GENERATE_MESSAGE', label: 'Gerar mensagem com IA' },
      { key: 'INSTAGRAM_PREVIEW_PROFILE', label: 'Visualizar perfil do Instagram' },
      { key: 'INSTAGRAM_SEND_MESSAGE', label: 'Enviar mensagem pelo Instagram' },
      { key: 'INSTAGRAM_CANCEL_DM', label: 'Cancelar DM preparada' },
    ],
  },
  {
    category: 'Automação',
    permissions: [
      { key: 'AUTOMATION_START', label: 'Iniciar automação' },
      { key: 'AUTOMATION_PAUSE', label: 'Pausar automação' },
      { key: 'AUTOMATION_TEST_CONNECTION', label: 'Testar conexão do Chrome/Instagram' },
    ],
  },
  {
    category: 'Configurações',
    permissions: [
      { key: 'SETTINGS_VIEW', label: 'Visualizar configurações' },
      { key: 'SETTINGS_EDIT', label: 'Alterar configurações' },
      { key: 'LEADS_IMPORT_CSV', label: 'Importar leads via CSV' },
      { key: 'INTEGRATION_TEST_META', label: 'Testar integração com Meta API' },
    ],
  },
  {
    category: 'Usuários',
    permissions: [
      { key: 'USERS_VIEW', label: 'Visualizar usuários' },
      { key: 'USERS_MANAGE', label: 'Criar, editar, desativar e definir permissões de usuários', highRisk: true },
    ],
  },
  {
    category: 'Auditoria',
    permissions: [
      { key: 'AUDIT_LOG_VIEW', label: 'Visualizar logs de atividade' },
    ],
  },
];

export const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSION_CATALOG.flatMap((group) =>
  group.permissions.map((permission) => permission.key),
);

// Presets só preenchem os checkboxes na tela de cadastro — quem manda de
// verdade, sempre, é o conjunto de permissões individuais gravado em
// user_permissions. SUPER_ADMIN nunca passa por essa lista: ele tem acesso
// total garantido no código (ver src/lib/auth-helpers.ts), não por preset.
export const PERMISSION_PRESETS: Record<string, PermissionKey[]> = {
  Administrador: ALL_PERMISSION_KEYS,
  Vendedor: [
    'DASHBOARD_VIEW',
    'LEAD_VIEW',
    'LEAD_UPDATE_STAGE',
    'LEAD_UPDATE_NOTES',
    'LEAD_MARK_DO_NOT_CONTACT',
    'LEAD_MARK_SENT',
    'LEAD_ENRICH',
    'AI_ANALYZE_LEAD',
    'AI_GENERATE_MESSAGE',
    'INSTAGRAM_PREVIEW_PROFILE',
    'INSTAGRAM_SEND_MESSAGE',
    'INSTAGRAM_CANCEL_DM',
  ],
  'Somente consulta': ['DASHBOARD_VIEW', 'LEAD_VIEW'],
};
