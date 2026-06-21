import { useState, useCallback } from "react";
export function useLog() {
  const [lines, setLines] = useState<string[]>([]);
  const log = useCallback((s: string) => setLines((l) => [...l, `${new Date().toLocaleTimeString()}  ${s}`]), []);
  return { lines, log };
}
