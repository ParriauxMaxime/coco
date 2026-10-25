import { useState } from 'react';
import { errorMessage } from '../api.ts';
import { toast } from './Toast.tsx';

// one in-flight action per component: pending is the key of the running one; run() toasts the error and resolves undefined
export function useAction() {
  const [pending, setPending] = useState<string | null>(null);
  const run = async <T>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setPending(key);
    try {
      return await fn();
    } catch (e) {
      toast.error(errorMessage(e));
      return undefined;
    } finally {
      setPending(null);
    }
  };
  return { pending, busy: pending !== null, run };
}

export const pendingClass = (on?: boolean | null) => (on ? ' pending' : '');
