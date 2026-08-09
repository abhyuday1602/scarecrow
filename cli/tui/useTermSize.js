// cli/tui/useTermSize.js — reactive terminal dimensions. The fullscreen shell sizes its
// root <Box> to the exact terminal so the header and search bar can be pinned; we must
// re-flow when the window resizes. Ink's useStdout gives the stream but not a reactive
// size, so we subscribe to its "resize" event and keep {rows, cols} in state.

import { useState, useEffect } from "react";
import { useStdout } from "ink";

export function useTermSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    rows: stdout?.rows || 24,
    cols: stdout?.columns || 80,
  });

  useEffect(() => {
    if (!stdout) return undefined;
    const onResize = () => setSize({ rows: stdout.rows || 24, cols: stdout.columns || 80 });
    stdout.on("resize", onResize);
    onResize(); // sync once in case it changed before we subscribed
    return () => stdout.off("resize", onResize);
  }, [stdout]);

  return size;
}
