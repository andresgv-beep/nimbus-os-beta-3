import { useMemo, useState, useRef } from 'react';
import styles from './WidgetGrid.module.css';

// ═══════════════════════════════════
// Grid Layout Engine
// Bin-packing: place each widget in the first available slot
// ═══════════════════════════════════

function computeLayout(widgets, columns) {
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

    for (let row = 0; !placed; row++) {
      for (let col = 0; col <= columns - w; col++) {
        if (fits(row, col, w, h)) {
          for (let r = row; r < row + h; r++) {
            for (let c = col; c < col + w; c++) {
              setCell(r, c, widget.id);
            }
          }
          positions.push({
            id: widget.id,
            col: col + 1,
            row: row + 1,
            colSpan: w,
            rowSpan: h,
          });
          placed = true;
          break;
        }
      }
      if (row > 20) break;
    }
  }

  return positions;
}

// ═══════════════════════════════════
// WidgetGrid
// ═══════════════════════════════════

export default function WidgetGrid({ widgets, columns = 6, mode = 'dynamic', renderWidget, editMode, onReorder, onExitEdit }) {
  const effectiveColumns = mode === 'classic' ? 1 : columns;
  const [dragOver, setDragOver] = useState(null);
  const dragItem = useRef(null);

  const layout = useMemo(
    () => computeLayout(widgets, effectiveColumns),
    [widgets, effectiveColumns]
  );

  if (!widgets || widgets.length === 0) return null;

  const wrapperClass = mode === 'classic'
    ? `${styles.gridWrapper} ${styles.classicMode}`
    : styles.gridWrapper;

  const handleDragStart = (e, index) => {
    dragItem.current = index;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index);
    // Make the drag image semi-transparent
    setTimeout(() => {
      if (e.target) e.target.style.opacity = '0.4';
    }, 0);
  };

  const handleDragEnd = (e) => {
    e.target.style.opacity = '1';
    dragItem.current = null;
    setDragOver(null);
  };

  const handleDragOver = (e, index) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOver !== index) setDragOver(index);
  };

  const handleDrop = (e, toIndex) => {
    e.preventDefault();
    const fromIndex = dragItem.current;
    setDragOver(null);
    if (fromIndex !== null && fromIndex !== toIndex && onReorder) {
      onReorder(fromIndex, toIndex);
    }
  };

  return (
    <div className={wrapperClass}>
      <div
        className={`${styles.grid} ${editMode ? styles.gridEdit : ''}`}
        style={{ '--widget-columns': effectiveColumns }}
      >
        {layout.map((pos, layoutIndex) => {
          const widget = widgets.find(w => w.id === pos.id);
          if (!widget) return null;
          const widgetIndex = widgets.findIndex(w => w.id === pos.id);
          const isDragTarget = dragOver === widgetIndex && dragItem.current !== widgetIndex;

          return (
            <div
              key={pos.id}
              className={`${styles.widgetSlot} ${editMode ? styles.widgetSlotEdit : ''} ${isDragTarget ? styles.widgetSlotDragOver : ''}`}
              style={{
                gridColumn: `${pos.col} / span ${pos.colSpan}`,
                gridRow: `${pos.row} / span ${pos.rowSpan}`,
              }}
              draggable={editMode}
              onDragStart={editMode ? (e) => handleDragStart(e, widgetIndex) : undefined}
              onDragEnd={editMode ? handleDragEnd : undefined}
              onDragOver={editMode ? (e) => handleDragOver(e, widgetIndex) : undefined}
              onDrop={editMode ? (e) => handleDrop(e, widgetIndex) : undefined}
            >
              {renderWidget(widget)}
              {editMode && (
                <div className={styles.editOverlay}>
                  <div className={styles.editGrip}>⠿</div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {editMode && (
        <div className={styles.editDoneWrap}>
          <button className={styles.editDoneBtn} onClick={onExitEdit} title="Done editing">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

export { computeLayout };
