import { create } from 'zustand';
import type {
  Project,
  ProjectListItem,
  ProjectMember,
  MilestoneWithGate,
} from '@/types/project';
import type { ProjectQuery } from '@/api/contract';
import { api } from '@/api/client';
import { useAuthStore } from './authStore';

/**
 * 项目域 store：列表筛选 + 当前项目详情聚合
 *
 * ⚠️ 方案一（Q-1）已删除阶段实体：详情态不再有 `stages`，
 * 里程碑（含挂载的质量门与关联任务统计）是概览页 / 里程碑页的唯一数据源。
 *
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
  /** 里程碑 + 门 + 门检查项 + 关联任务统计（取代原 stages） */
  milestones: MilestoneWithGate[];
  detailLoading: boolean;

  setQuery: (patch: Partial<ProjectQuery>) => void;
  fetchList: () => Promise<void>;
  fetchDetail: (id: string) => Promise<void>;
  refreshMilestones: (id: string) => Promise<void>;
  /** 里程碑变动会连带影响项目健康度 / 进度，需要一并刷新项目主体 */
  refreshProject: (id: string) => Promise<void>;
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
      const [project, members, milestones] = await Promise.all([
        api.getProject(id),
        api.listMembers(id),
        api.listMilestones(id),
      ]);
      set({ current: project, members, milestones });
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

  async refreshMilestones(id) {
    set({ milestones: await api.listMilestones(id) });
  },

  async refreshProject(id) {
    const [project, milestones] = await Promise.all([api.getProject(id), api.listMilestones(id)]);
    set({ current: project, milestones });
  },

  clearDetail() {
    set({ current: null, members: [], milestones: [] });
    useAuthStore.getState().setProjectRoles([]);
  },
}));
