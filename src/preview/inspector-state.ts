import { create } from 'zustand';
import { useWorkbench } from '../workbench/workbench-store.ts';
import type { PrKey, ReviewComment } from '../workbench/types.ts';

type Jump = { n: PrKey; c: ReviewComment };
type InspectorState = { pickedPr: Record<string, string | null>; hostedReview: string | null; jump: Jump | null };

export const useInspector = create<InspectorState>(() => ({ pickedPr: {}, hostedReview: null, jump: null }));

export const pickPr = (view: string, key: string | null) => useInspector.setState((s) => (s.pickedPr[view] === key ? s : { pickedPr: { ...s.pickedPr, [view]: key } }));
export const hostReview = (tabId: string | null) => useInspector.setState({ hostedReview: tabId });
export const requestJump = (n: PrKey, c: ReviewComment) => {
  useWorkbench.getState().open(`review-${n}`);
  useInspector.setState({ jump: { n, c } });
};
