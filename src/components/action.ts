import { useState } from 'react';
import { toast } from './Toast.tsx';

// one in-flight action per component: pending is the key of the running one; run() toasts the error and resolves undefined
export function useAction() {
  const [pending, setPending] = useState(null);
  const run = async (key, fn) => {
    setPending(key);
    try {
      return await fn();
    } catch (e) {
      toast.error(e.message);
      return undefined;
    } finally {
      setPending(null);
    }
  };
  return { pending, busy: pending !== null, run };
}

export const pendingClass = (on) => (on ? ' pending' : '');
