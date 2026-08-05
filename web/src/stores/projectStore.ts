import { create } from 'zustand';
import type {
  Project,
  ProjectListItem,
  ProjectMember,
  StageWithGate,
  Milestone,
} from '@/types/project';
import type { ProjectQuery } from '@/api/contract';
import { api } from '@/api/client';
import { useAuthStore } from './authStore';

/**
 * 项目域 store：列表筛选 + 当前项目详情聚合
 * @prd P0-01 P0-02 P0-03 P0-04 P0-05 P0-17
 */
interface ProjectState {
  /* 列表 */
  list: ProjectListItem[];
  total: number;
  query: ProjectQuery;
  listLoading: boolean;

  /* 详情 */
  current: Project | null;
  members: ProjectMember[];
  stages: StageWithGate[];
  milestones: Milestone[];
  detailLoading: boolean;

  setQuery: (patch: Partial<ProjectQuery>) => void;
  fetchList: () => Promise<void>;
  fetchDetail: (id: string) => Promise<void>;
  refreshStages: (id: string) => Promise<void>;
  refreshMilestones: (id: string) => Promise<void>;
  clearDetail: () => void;
}

const DEFAULT_QUERY: ProjectQuery = {
  keyword: '',
  type: '',
  status: '',
  health: '',
  onlyMine: false,
  page: 1,
  pageSize: 12,
};

export const useProjectStore = create<ProjectState>((set, get) => ({
  list: [],
  total: 0,
  query: { ...DEFAULT_QUERY },
  listLoading: false,
  current: null,
  members: [],
  stages: [],
  milestones: [],
  detailLoading: false,

  setQuery(patch) {
    const next = { ...get().query, ...patch };
    if (!('page' in patch)) next.page = 1;
    set({ query: next });
  },

  async fetchList() {
    set({ listLoading: true });
    try {
      const res = await api.listProjects(get().query);
      set({ list: res.items, total: res.total });
    } finally {
      set({ listLoading: false });
    }
  },

  async fetchDetail(id) {
    set({ detailLoading: true });
    try {
      const [project, members, stages, milestones] = await Promise.all([
        api.getProject(id),
        api.listMembers(id),
        api.listStages(id),
        api.listMilestones(id),
      ]);
      set({ current: project, members, stages, milestones });
      const me = useAuthStore.getState().user;
      if (me) {
        useAuthStore
          .getState()
          .setProjectRoles(members.filter((m) => m.userOpenId === me.openId).map((m) => m.projectRole));
      }
    } finally {
      set({ detailLoading: false });
    }
  },

  async refreshStages(id) {
    set({ stages: await api.listStages(id) });
  },

  async refreshMilestones(id) {
    set({ milestones: await api.listMilestones(id) });
  },

  clearDetail() {
    set({ current: null, members: [], stages: [], milestones: [] });
    useAuthStore.getState().setProjectRoles([]);
  },
}));
