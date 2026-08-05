import { create } from 'zustand';
import type { Review } from '@/types/review';
import type { Change } from '@/types/change';
import type { Report } from '@/types/report';
import type { AuditLog } from '@/types/audit';
import type { CreateReviewPayload, DecisionPayload, ChangePayloadInput, AuditQuery, ReportPayload } from '@/api/contract';
import { api } from '@/api/client';

/**
 * 流程域 store：评审 / 变更 / 周报 / 审计
 * @prd P0-08 P0-09 P0-14 P0-15
 */
interface FlowState {
  reviews: Review[];
  myApprovals: Review[];
  changes: Change[];
  reports: Report[];
  auditLogs: AuditLog[];
  auditTotal: number;
  loading: boolean;

  fetchReviews: (projectId?: string) => Promise<void>;
  fetchMyApprovals: () => Promise<void>;
  createReview: (payload: CreateReviewPayload) => Promise<Review>;
  approve: (id: string, payload: DecisionPayload) => Promise<Review>;
  reject: (id: string, payload: DecisionPayload) => Promise<Review>;
  withdraw: (id: string, payload: DecisionPayload) => Promise<Review>;

  fetchChanges: (projectId: string) => Promise<void>;
  createChange: (payload: ChangePayloadInput) => Promise<Change>;
  submitChange: (id: string) => Promise<Change>;
  applyChange: (id: string) => Promise<Change>;

  fetchReports: (projectId: string) => Promise<void>;
  saveReport: (payload: ReportPayload) => Promise<Report>;
  submitReport: (payload: ReportPayload) => Promise<Report>;

  fetchAudit: (query: AuditQuery) => Promise<void>;
}

export const useFlowStore = create<FlowState>((set, get) => ({
  reviews: [],
  myApprovals: [],
  changes: [],
  reports: [],
  auditLogs: [],
  auditTotal: 0,
  loading: false,

  async fetchReviews(projectId) {
    set({ loading: true });
    try {
      set({ reviews: await api.listReviews(projectId) });
    } finally {
      set({ loading: false });
    }
  },

  async fetchMyApprovals() {
    set({ loading: true });
    try {
      set({ myApprovals: await api.listMyApprovals() });
    } finally {
      set({ loading: false });
    }
  },

  async createReview(payload) {
    const review = await api.createReview(payload);
    set({ reviews: await api.listReviews(payload.projectId) });
    return review;
  },

  async approve(id, payload) {
    const review = await api.approveReview(id, payload);
    set({ myApprovals: await api.listMyApprovals() });
    const pid = get().reviews[0]?.projectId;
    if (pid) set({ reviews: await api.listReviews(pid) });
    return review;
  },

  async reject(id, payload) {
    const review = await api.rejectReview(id, payload);
    set({ myApprovals: await api.listMyApprovals() });
    const pid = get().reviews[0]?.projectId;
    if (pid) set({ reviews: await api.listReviews(pid) });
    return review;
  },

  async withdraw(id, payload) {
    const review = await api.withdrawReview(id, payload);
    set({ myApprovals: await api.listMyApprovals() });
    return review;
  },

  async fetchChanges(projectId) {
    set({ loading: true });
    try {
      set({ changes: await api.listChanges(projectId) });
    } finally {
      set({ loading: false });
    }
  },

  async createChange(payload) {
    const change = await api.createChange(payload);
    set({ changes: await api.listChanges(payload.projectId) });
    return change;
  },

  async submitChange(id) {
    const change = await api.submitChange(id);
    set({ changes: await api.listChanges(change.projectId) });
    return change;
  },

  async applyChange(id) {
    const change = await api.applyChange(id);
    set({ changes: await api.listChanges(change.projectId) });
    return change;
  },

  async fetchReports(projectId) {
    set({ loading: true });
    try {
      set({ reports: await api.listReports(projectId) });
    } finally {
      set({ loading: false });
    }
  },

  async saveReport(payload) {
    const report = await api.saveReport(payload);
    set({ reports: await api.listReports(payload.projectId) });
    return report;
  },

  async submitReport(payload) {
    const report = await api.submitReport(payload);
    set({ reports: await api.listReports(payload.projectId) });
    return report;
  },

  async fetchAudit(query) {
    set({ loading: true });
    try {
      const res = await api.listAudit(query);
      set({ auditLogs: res.items, auditTotal: res.total });
    } finally {
      set({ loading: false });
    }
  },
}));
