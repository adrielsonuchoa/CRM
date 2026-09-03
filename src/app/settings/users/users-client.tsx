'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PERMISSION_CATALOG, PERMISSION_PRESETS, ALL_PERMISSION_KEYS, type PermissionKey } from '@/lib/permissions';
import { createUserAction, updateUserAction } from './actions';
import { UserPlus, ShieldAlert, Eye, EyeOff, KeyRound, Users as UsersIcon } from 'lucide-react';

type UserRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  permissions: string[];
};

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Administrador',
  VENDEDOR: 'Vendedor',
};

function roleBadgeVariant(role: string): 'default' | 'secondary' | 'outline' {
  if (role === 'SUPER_ADMIN') return 'default';
  if (role === 'ADMIN') return 'secondary';
  return 'outline';
}

type FormState = {
  name: string;
  email: string;
  password: string;
  role: string;
  status: string;
  permissions: Set<PermissionKey>;
};

const EMPTY_FORM: FormState = {
  name: '',
  email: '',
  password: '',
  role: 'VENDEDOR',
  status: 'ACTIVE',
  permissions: new Set(PERMISSION_PRESETS.Vendedor),
};

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

export function UsersClient({
  initialUsers,
  currentUserId,
  canManage,
}: {
  initialUsers: UserRow[];
  currentUserId: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [activeTab, setActiveTab] = useState<'dados' | 'permissoes'>('dados');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEditingSelf = editingUser?.id === currentUserId;

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return initialUsers;
    return initialUsers.filter(
      (u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
    );
  }, [search, initialUsers]);

  function openCreateDialog() {
    setEditingUser(null);
    setForm({ ...EMPTY_FORM, permissions: new Set(PERMISSION_PRESETS.Vendedor) });
    setActiveTab('dados');
    setError(null);
    setShowPassword(false);
    setDialogOpen(true);
  }

  function openEditDialog(user: UserRow) {
    setEditingUser(user);
    setForm({
      name: user.name,
      email: user.email,
      password: '',
      role: user.role,
      status: user.status,
      permissions: new Set(user.permissions as PermissionKey[]),
    });
    setActiveTab('dados');
    setError(null);
    setShowPassword(false);
    setDialogOpen(true);
  }

  function togglePermission(key: PermissionKey) {
    setForm((prev) => {
      const next = new Set(prev.permissions);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, permissions: next };
    });
  }

  function applyPreset(presetName: keyof typeof PERMISSION_PRESETS) {
    setForm((prev) => ({ ...prev, permissions: new Set(PERMISSION_PRESETS[presetName]) }));
  }

  function selectAll() {
    setForm((prev) => ({ ...prev, permissions: new Set(ALL_PERMISSION_KEYS) }));
  }

  function selectNone() {
    setForm((prev) => ({ ...prev, permissions: new Set() }));
  }

  async function handleSubmit() {
    setError(null);
    if (!form.name.trim()) return setError('Informe o nome.');
    if (!form.email.trim()) return setError('Informe o e-mail.');
    if (!editingUser && form.password.length < 8) return setError('A senha precisa ter pelo menos 8 caracteres.');
    if (form.password && form.password.length < 8) return setError('A senha precisa ter pelo menos 8 caracteres.');

    setSaving(true);
    const fd = new FormData();
    fd.set('name', form.name.trim());
    fd.set('email', form.email.trim());
    if (form.password) fd.set('password', form.password);
    fd.set('role', form.role);
    fd.set('status', form.status);
    for (const key of form.permissions) fd.append('permissions', key);

    const result = editingUser ? await updateUserAction(editingUser.id, fd) : await createUserAction(fd);
    setSaving(false);

    if (result.success) {
      setDialogOpen(false);
      router.refresh();
    } else {
      setError(result.error ?? 'Não foi possível salvar.');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nome ou e-mail..."
          className="max-w-sm"
        />
        {canManage && (
          <Button onClick={openCreateDialog} size="sm">
            <UserPlus className="w-4 h-4 mr-2" />
            Novo usuário
          </Button>
        )}
      </div>

      <div className="border border-neutral-200 dark:border-neutral-800 rounded-lg bg-white dark:bg-neutral-950 shadow-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-neutral-50 dark:bg-neutral-900/50">
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>E-mail</TableHead>
              <TableHead>Papel</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Último login</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-16 text-neutral-400">
                  <div className="flex flex-col items-center gap-3">
                    <UsersIcon className="w-10 h-10 opacity-30" />
                    <p className="text-base">{search ? `Nenhum resultado para "${search}"` : 'Nenhum usuário cadastrado.'}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((u) => (
                <TableRow key={u.id} className={u.status === 'INACTIVE' ? 'opacity-50' : ''}>
                  <TableCell className="font-medium">
                    {u.name}
                    {u.id === currentUserId && <span className="ml-1.5 text-xs text-neutral-400">(você)</span>}
                  </TableCell>
                  <TableCell className="text-sm text-neutral-600 dark:text-neutral-400">{u.email}</TableCell>
                  <TableCell>
                    <Badge variant={roleBadgeVariant(u.role)} className="text-xs">
                      {ROLE_LABELS[u.role] ?? u.role}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={u.status === 'ACTIVE' ? 'secondary' : 'destructive'} className="text-xs">
                      {u.status === 'ACTIVE' ? 'Ativo' : 'Inativo'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-neutral-500">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('pt-BR') : 'Nunca'}
                  </TableCell>
                  <TableCell className="text-right">
                    {canManage ? (
                      <button
                        onClick={() => openEditDialog(u)}
                        className="text-sm font-medium text-blue-600 hover:underline"
                      >
                        Editar →
                      </button>
                    ) : (
                      <span className="text-sm text-neutral-400">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingUser ? `Editar ${editingUser.name}` : 'Novo usuário'}</DialogTitle>
            <DialogDescription>
              {editingUser
                ? 'Altere os dados ou as permissões deste usuário.'
                : 'Só o SUPER_ADMIN ou quem tiver a permissão de gerenciar usuários pode criar contas — não existe cadastro público.'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
            <button
              onClick={() => setActiveTab('dados')}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${activeTab === 'dados' ? 'border-blue-600 text-blue-600' : 'border-transparent text-neutral-500 hover:text-neutral-700'}`}
            >
              Dados
            </button>
            <button
              onClick={() => setActiveTab('permissoes')}
              disabled={isEditingSelf}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px disabled:opacity-40 disabled:cursor-not-allowed ${activeTab === 'permissoes' ? 'border-blue-600 text-blue-600' : 'border-transparent text-neutral-500 hover:text-neutral-700'}`}
              title={isEditingSelf ? 'Você não pode alterar suas próprias permissões.' : undefined}
            >
              Permissões {!isEditingSelf && `(${form.permissions.size})`}
            </button>
          </div>

          {error && (
            <div className="flex items-center gap-2 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 rounded-lg p-3 text-sm">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          {activeTab === 'dados' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="user-name">Nome</Label>
                  <Input id="user-name" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="user-email">E-mail</Label>
                  <Input id="user-email" type="email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="user-password">
                  {editingUser ? 'Nova senha (opcional)' : 'Senha inicial'}
                </Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      id="user-password"
                      type={showPassword ? 'text' : 'password'}
                      value={form.password}
                      onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
                      placeholder={editingUser ? 'Deixe em branco para manter a senha atual' : 'Mínimo 8 caracteres'}
                      className="pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute inset-y-0 right-0 flex items-center px-2.5 text-muted-foreground hover:text-foreground"
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => { setForm((p) => ({ ...p, password: randomPassword() })); setShowPassword(true); }}
                    title="Gerar senha forte"
                  >
                    <KeyRound className="w-4 h-4" />
                  </Button>
                </div>
                <p className="text-xs text-neutral-400">
                  Não há envio de e-mail configurado — combine a senha com a pessoa por um canal seguro (ex.: WhatsApp).
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="user-role">Papel</Label>
                  <select
                    id="user-role"
                    value={form.role}
                    disabled={isEditingSelf}
                    onChange={(e) => setForm((p) => ({ ...p, role: e.target.value }))}
                    className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed dark:bg-input/30"
                  >
                    <option value="VENDEDOR">Vendedor</option>
                    <option value="ADMIN">Administrador</option>
                    <option value="SUPER_ADMIN">Super Admin</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="user-status">Status</Label>
                  <select
                    id="user-status"
                    value={form.status}
                    disabled={isEditingSelf}
                    onChange={(e) => setForm((p) => ({ ...p, status: e.target.value }))}
                    className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed dark:bg-input/30"
                  >
                    <option value="ACTIVE">Ativo</option>
                    <option value="INACTIVE">Inativo</option>
                  </select>
                </div>
              </div>

              {isEditingSelf && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Você está editando sua própria conta: papel, status e permissões não podem ser alterados por aqui.
                </p>
              )}
            </div>
          )}

          {activeTab === 'permissoes' && !isEditingSelf && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-1.5">
                <Button type="button" variant="outline" size="xs" onClick={() => applyPreset('Administrador')}>Preset: Administrador</Button>
                <Button type="button" variant="outline" size="xs" onClick={() => applyPreset('Vendedor')}>Preset: Vendedor</Button>
                <Button type="button" variant="outline" size="xs" onClick={() => applyPreset('Somente consulta')}>Preset: Somente consulta</Button>
                <Button type="button" variant="ghost" size="xs" onClick={selectAll}>Selecionar todas</Button>
                <Button type="button" variant="ghost" size="xs" onClick={selectNone}>Limpar seleção</Button>
              </div>

              <div className="space-y-4 max-h-80 overflow-y-auto pr-1">
                {PERMISSION_CATALOG.map((group) => (
                  <div key={group.category} className="space-y-1.5">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{group.category}</h4>
                    <div className="space-y-1">
                      {group.permissions.map((perm) => (
                        <label
                          key={perm.key}
                          className="flex items-start gap-2 text-sm rounded-md px-2 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-900 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={form.permissions.has(perm.key)}
                            onChange={() => togglePermission(perm.key)}
                            className="mt-0.5"
                          />
                          <span className="flex-1">
                            <span className="flex items-center gap-1.5">
                              {perm.label}
                              {perm.highRisk && (
                                <Badge variant="destructive" className="text-[10px]">alto risco</Badge>
                              )}
                            </span>
                            {perm.description && (
                              <span className="block text-xs text-neutral-400">{perm.description}</span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancelar</Button>
            <Button onClick={handleSubmit} disabled={saving}>
              {saving ? 'Salvando...' : editingUser ? 'Salvar alterações' : 'Criar usuário'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
