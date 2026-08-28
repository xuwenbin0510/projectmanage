import { create } from 'zustand';
import type { User, ProjectRole } from '@/types/project';
import { api, setToken, USE_MOCK } from '@/api/client';
import { canDo, hydratePermissions, resetPermissions } from '@/config/permissions';

/** 登录/恢复会话后拉取当前生效矩阵并注入前端 canDo（与后端同源） */
async function hydrateMatrix(): Promise<void> {
  try {
    const { matrix } = await api.getMetaPermissionMatrix();
    hydratePermissions(matrix);
  } catch {
    // 拉取失败不阻塞登录：回落编译期 PERMISSIONS 常量
    resetPermissions();
  }
}

/**
 * 认证与权限镜像 store
 * @prd P0-11（飞书免登 / 开发登录） P0-10（角色体系与 RBAC 镜像）
 * 注意：前端权限仅控制按钮可见性，最终以服务端判定为准
 */
interface AuthState {
  user: User | null;
  loading: boolean;
  ready: boolean;
  /** 当前项目内我的角色（进入项目详情时写入；值为职位 role_key，不再限定固定联合类型） */
  projectRoles: string[];
  /** 邮箱密码登录 */
  loginWithPassword: (email: string, password: string) => Promise<{ user: User; mustChangePwd: boolean }>;
  login: (openId: string) => Promise<User>;
  loginByCode: (code: string) => Promise<User>;
  /** 浏览器飞书 Web OAuth 回调登录（普通浏览器，不经过 JSSDK） */
  loginByFeishuWeb: (code: string) => Promise<User>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>;
  bootstrap: () => Promise<void>;
  logout: () => Promise<void>;
  setProjectRoles: (roles: string[]) => void;
  can: (action: string) => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  loading: false,
  ready: false,
  projectRoles: [],

  async loginWithPassword(email, password) {
    set({ loading: true });
    try {
      const session = await api.login(email, password);
      if (!USE_MOCK) setToken(session.token);
      else localStorage.setItem('pm_token', session.token);
      set({ user: session.user, ready: true });
      void hydrateMatrix();
      return { user: session.user, mustChangePwd: !!session.mustChangePwd };
    } finally {
      set({ loading: false });
    }
  },

  async login(openId) {
    set({ loading: true });
    try {
      const session = await api.devLogin(openId);
      if (!USE_MOCK) setToken(session.token);
      else localStorage.setItem('pm_token', session.token);
      set({ user: session.user, ready: true });
      void hydrateMatrix();
      return session.user;
    } finally {
      set({ loading: false });
    }
  },

  async loginByCode(code) {
    set({ loading: true });
    try {
      const session = await api.feishuLogin(code);
      localStorage.setItem('pm_token', session.token);
      set({ user: session.user, ready: true });
      void hydrateMatrix();
      return session.user;
    } finally {
      set({ loading: false });
    }
  },

  /** 浏览器飞书 Web OAuth：换 token 后落到同一用户态（与 loginByCode 对齐） */
  async loginByFeishuWeb(code) {
    set({ loading: true });
    try {
      const { token, user } = await api.loginByFeishuCode(code);
      setToken(token);
      set({ user, ready: true });
      void hydrateMatrix();
      return user;
    } finally {
      set({ loading: false });
    }
  },

  /** 应用启动时尝试恢复会话 */
  async bootstrap() {
    set({ loading: true });
    try {
      const fresh = await api.me();
      // 防御性合并：登录态已注入的 globalRoles 可能比 /me 更完整（多职位用户经 user_roles 拥有额外职位），
      // 取并集保留权限，避免被较窄结果覆盖导致后台管理等菜单消失（Bug2）。
      const prev = get().user;
      if (prev) {
        const merged = Array.from(
          new Set([...(fresh.globalRoles || []), ...(prev.globalRoles || [])]),
        );
        if (merged.length) fresh.globalRoles = merged;
        if (!fresh.globalRole && prev.globalRole) fresh.globalRole = prev.globalRole;
      }
      set({ user: fresh });
      void hydrateMatrix();
    } catch {
      set({ user: null });
    } finally {
      set({ loading: false, ready: true });
    }
  },

  async changePassword(oldPassword, newPassword) {
    await api.changePassword(oldPassword, newPassword);
  },

  async logout() {
    try {
      await api.logout();
    } finally {
      localStorage.removeItem('pm_token');
      setToken('');
      resetPermissions();
      set({ user: null, projectRoles: [] });
    }
  },

  setProjectRoles(roles) {
    set({ projectRoles: roles });
  },

  can(action) {
    const { user, projectRoles } = get();
    if (!user) return false;
    // E1.5：取全部全局职位（并集）；后端未返回 globalRoles 时回落单值 globalRole
    const globalRoles = Array.isArray(user.globalRoles) && user.globalRoles.length
      ? user.globalRoles
      : [user.globalRole];
    return canDo(globalRoles, action, projectRoles);
  },
}));
