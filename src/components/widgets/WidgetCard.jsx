import { useState, useRef, useEffect } from 'react';
import styles from './WidgetCard.module.css';

export default function WidgetCard({ title, icon, size = '1x1', onClick, children, loading, error, widgetId, availableSizes, onResize, onRemove, onAddWidget, onEditGrid }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showSizes, setShowSizes] = useState(false);
  const menuRef = useRef(null);

  const [cols, rows] = size.split('x').map(Number);
  const sizeClass =
    cols === 1 && rows === 1 ? styles.sizeSmall :
    cols === 2 && rows === 1 ? styles.sizeWide :
    cols === 2 && rows === 2 ? styles.sizeLarge : '';

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
        setShowSizes(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const handleMenuClick = (e) => {
    e.stopPropagation();
    setMenuOpen(!menuOpen);
    setShowSizes(false);
  };

  const sizeLabels = { '1x1': 'Small (1×1)', '2x1': 'Wide (2×1)', '2x2': 'Large (2×2)' };

  return (
    <div
      className={`${styles.card} ${sizeClass}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' && onClick) onClick(); }}
    >
      {/* Header */}
      <div className={styles.header}>
        {icon && <div className={styles.headerIcon}>{icon}</div>}
        <div className={styles.headerTitle}>{title}</div>
        <div className={styles.headerMenu} ref={menuRef}>
          <div className={styles.menuDots} onClick={handleMenuClick}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
            </svg>
          </div>

          {menuOpen && (
            <div className={styles.dropdown}>
              {/* Resize */}
              {availableSizes && availableSizes.length > 1 && (
                <div
                  className={styles.dropItem}
                  onClick={(e) => { e.stopPropagation(); setShowSizes(!showSizes); }}
                >
                  Resize
                  <span className={styles.dropArrow}>›</span>
                </div>
              )}
              {showSizes && availableSizes && (
                <div className={styles.dropSub}>
                  {availableSizes.map(s => (
                    <div
                      key={s}
                      className={`${styles.dropItem} ${s === size ? styles.dropItemActive : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onResize && s !== size) onResize(widgetId, s);
                        setMenuOpen(false);
                        setShowSizes(false);
                      }}
                    >
                      {sizeLabels[s] || s}
                      {s === size && <span className={styles.dropCheck}>✓</span>}
                    </div>
                  ))}
                </div>
              )}

              {/* Edit Grid */}
              {onEditGrid && (
                <div
                  className={styles.dropItem}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditGrid();
                    setMenuOpen(false);
                  }}
                >
                  Edit Grid
                </div>
              )}

              {/* Add Widget */}
              {onAddWidget && (
                <div
                  className={styles.dropItem}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAddWidget();
                    setMenuOpen(false);
                  }}
                >
                  Add Widget
                </div>
              )}

              {/* Separator */}
              {onRemove && <div className={styles.dropSep} />}

              {/* Remove */}
              {onRemove && (
                <div
                  className={`${styles.dropItem} ${styles.dropItemDanger}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(widgetId);
                    setMenuOpen(false);
                  }}
                >
                  Remove
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div className={styles.body}>
        {loading ? (
          <div className={styles.loading}>
            <div className={styles.loadingDot} />
            <div className={styles.loadingDot} />
            <div className={styles.loadingDot} />
          </div>
        ) : error ? (
          <div className={styles.error}>{error}</div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
