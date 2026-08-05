import { create } from 'zustand';
import type { WbsNode, WbsTreeNode, BoardView, TaskStatus } from '@/types/wbs';
import type { ProjectType } from '@/types/project';
import type { WbsNodePayload } from '@/api/contract';
import { api } from '@/api/client';
import { buildTree } from '@/utils/wbs';

/**
 * WBS + 看板 store
 * @prd P0-06（WBS 树与工作包） P0-07（看板 + WIP）
 */
interface WbsState {
  projectId: string;
  projectType: ProjectType;
  nodes: WbsNode[];
  tree: WbsTreeNode[];
  board: BoardView | null;
  loading: boolean;
  boardLoading: boolean;

  fetchWbs: (projectId: string, projectType: ProjectType) => Promise<void>;
  fetchBoard: (projectId: string) => Promise<void>;
  createNode: (payload: WbsNodePayload) => Promise<WbsNode>;
  updateNode: (id: string, payload: Partial<WbsNodePayload>) => Promise<WbsNode>;
  deleteNode: (id: string) => Promise<void>;
  moveNode: (id: string, newParentId: string | null, index: number) => Promise<void>;
  moveTask: (nodeId: string, status: TaskStatus, order: number) => Promise<void>;
  setWipLimit: (status: TaskStatus, limit: number) => Promise<void>;
}

export const useWbsStore = create<WbsState>((set, get) => ({
  projectId: '',
  projectType: 'A',
  nodes: [],
  tree: [],
  board: null,
  loading: false,
  boardLoading: false,

  async fetchWbs(projectId, projectType) {
    set({ loading: true, projectId, projectType });
    try {
      const nodes = await api.listWbs(projectId);
      set({ nodes, tree: buildTree(nodes, projectType) });
    } finally {
      set({ loading: false });
    }
  },

  async fetchBoard(projectId) {
    set({ boardLoading: true, projectId });
    try {
      set({ board: await api.getBoard(projectId) });
    } finally {
      set({ boardLoading: false });
    }
  },

  async createNode(payload) {
    const { projectId, projectType } = get();
    const node = await api.createWbsNode(projectId, payload);
    const nodes = await api.listWbs(projectId);
    set({ nodes, tree: buildTree(nodes, projectType) });
    return node;
  },

  async updateNode(id, payload) {
    const { projectId, projectType } = get();
    const node = await api.updateWbsNode(id, payload);
    const nodes = await api.listWbs(projectId);
    set({ nodes, tree: buildTree(nodes, projectType) });
    return node;
  },

  async deleteNode(id) {
    const { projectId, projectType } = get();
    await api.deleteWbsNode(id);
    const nodes = await api.listWbs(projectId);
    set({ nodes, tree: buildTree(nodes, projectType) });
  },

  async moveNode(id, newParentId, index) {
    const { projectType } = get();
    const nodes = await api.moveWbsNode(id, newParentId, index);
    set({ nodes, tree: buildTree(nodes, projectType) });
  },

  async moveTask(nodeId, status, order) {
    const board = await api.moveTask(nodeId, status, order);
    set({ board });
    const { projectId, projectType } = get();
    if (projectId) {
      const nodes = await api.listWbs(projectId);
      set({ nodes, tree: buildTree(nodes, projectType) });
    }
  },

  async setWipLimit(status, limit) {
    const { projectId, board } = get();
    const wipLimits = { ...(board?.config.wipLimits ?? {}), [status]: limit };
    await api.updateBoardConfig(projectId, wipLimits);
    set({ board: await api.getBoard(projectId) });
  },
}));
