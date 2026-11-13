import { useCallback, useState } from 'react';

export function useNodeResizeState() {
  const [resizing, setResizing] = useState(false);
  const onResizeStart = useCallback(() => setResizing(true), []);
  const onResizeEnd = useCallback(() => setResizing(false), []);
  return { resizing, onResizeStart, onResizeEnd };
}
