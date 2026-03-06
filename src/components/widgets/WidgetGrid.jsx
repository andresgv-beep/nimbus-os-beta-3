import { useMemo } from 'react';
import styles from './WidgetGrid.module.css';

// ═══════════════════════════════════
// Grid Layout Engine
// Bin-packing: place each widget in the first available slot
// ═══════════════════════════════════

function computeLayout(widgets, columns) {
  // Grid is a 2D array tracking occupied cells
  // We expand rows as needed
  const grid = [];
  const positions = [];

  const getCell = (r, c) => (grid[r] && grid[r][c]) || null;
  const setCell = (r, c, id) => {
    while (grid.length <= r) grid.push(new Array(columns).fill(null));
    grid[r][c] = id;
  };

  const fits = (row, col, w, h) => {
    if (col + w > columns) return false;
    for (let r = row; r < row + h; r++) {
      for (let c = col; c < col + w; c++) {
        if (getCell(r, c) !== null) return false;
      }
    }
    return true;
  };

  for (const widget of widgets) {
    const [w, h] = widget.size.split('x').map(Number);
    let placed = false;

    // Scan row by row, col by col for the first fit
    for (let row = 0; !placed; row++) {
      for (let col = 0; col <= columns - w; col++) {
        if (fits(row, col, w, h)) {
          // Place it
          for (let r = row; r < row + h; r++) {
            for (let c = col; c < col + w; c++) {
              setCell(r, c, widget.id);
            }
          }
          positions.push({
            id: widget.id,
            col: col + 1,       // CSS grid is 1-indexed
            row: row + 1,
            colSpan: w,
            rowSpan: h,
          });
          placed = true;
          break;
        }
      }
      // Safety: don't go beyond 20 rows
      if (row > 20) break;
    }
  }

  return positions;
}

// ═══════════════════════════════════
// WidgetGrid — renders widgets in a puzzle grid
// ═══════════════════════════════════

export default function WidgetGrid({ widgets, columns = 4, mode = 'dynamic', renderWidget }) {
  const effectiveColumns = mode === 'classic' ? 1 : columns;

  const layout = useMemo(
    () => computeLayout(widgets, effectiveColumns),
    [widgets, effectiveColumns]
  );

  if (!widgets || widgets.length === 0) return null;

  const wrapperClass = mode === 'classic'
    ? `${styles.gridWrapper} ${styles.classicMode}`
    : styles.gridWrapper;

  return (
    <div className={wrapperClass}>
      <div
        className={styles.grid}
        style={{ '--widget-columns': effectiveColumns }}
      >
        {layout.map((pos) => {
          const widget = widgets.find(w => w.id === pos.id);
          if (!widget) return null;

          return (
            <div
              key={pos.id}
              className={styles.widgetSlot}
              style={{
                gridColumn: `${pos.col} / span ${pos.colSpan}`,
                gridRow: `${pos.row} / span ${pos.rowSpan}`,
              }}
            >
              {renderWidget(widget)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Export the layout engine for testing
export { computeLayout };
