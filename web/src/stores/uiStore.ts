import { create } from 'zustand';

/** 全局 UI 状态（侧边栏折叠、移动端抽屉） */
interface UiState {
  sidebarCollapsed: boolean;
  mobileDrawerOpen: boolean;
  toggleSidebar: () => void;
  setMobileDrawer: (open: boolean) => void;
}

const KEY = 'pm_sidebar_collapsed';

export const useUiStore = create<UiState>((set, get) => ({
  sidebarCollapsed: localStorage.getItem(KEY) === '1',
  mobileDrawerOpen: false,

  toggleSidebar() {
    const next = !get().sidebarCollapsed;
    localStorage.setItem(KEY, next ? '1' : '0');
    set({ sidebarCollapsed: next });
  },

  setMobileDrawer(open) {
    set({ mobileDrawerOpen: open });
  },
}));
