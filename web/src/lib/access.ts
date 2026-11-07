import type { Access } from '@/api/types';

const rank: Record<Access, number> = { viewer: 1, operator: 2, manager: 3, owner: 4, admin: 4 };

export const canOperate = (a: Access | undefined) => !!a && rank[a] >= 2;
export const canManage = (a: Access | undefined) => !!a && rank[a] >= 3;
export const isFull = (a: Access | undefined) => !!a && rank[a] >= 4;
