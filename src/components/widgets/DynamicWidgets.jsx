import { useState } from 'react';
import { useWindows, useTheme } from '@context';
import WidgetGrid from './WidgetGrid';
import ClockWidget from './ClockWidget';
import SystemMonitorWidget from './SystemMonitorWidget';
import DiskPoolWidget from './DiskPoolWidget';
import NetworkWidget from './NetworkWidget';
import UptimeWidget from './UptimeWidget';
import NimTorrentWidget from './NimTorrentWidget';

// ═══════════════════════════════════
// Widget Registry
// ═══════════════════════════════════

const WIDGET_REGISTRY = {
  'clock':          { component: ClockWidget,         label: 'Clock',          sizes: ['1x1'], icon: '🕐' },
  'system-monitor': { component: SystemMonitorWidget, label: 'System Monitor', sizes: ['2x1', '2x2'], icon: '📊' },
  'disk-pool':      { component: DiskPoolWidget,      label: 'Disk Pool',      sizes: ['1x1', '2x1'], icon: '💾' },
  'network':        { component: NetworkWidget,       label: 'Network',        sizes: ['1x1', '2x1'], icon: '🌐' },
  'uptime':         { component: UptimeWidget,        label: 'Uptime',         sizes: ['1x1'], icon: '⏱' },
  'nimtorrent':     { component: NimTorrentWidget,    label: 'NimTorrent',     sizes: ['1x1', '2x1', '2x2'], icon: '⬇' },
};

const DEFAULT_WIDGETS = [
  { id: 'clock',          size: '1x1' },
  { id: 'disk-pool',      size: '1x1' },
  { id: 'system-monitor', size: '2x1' },
  { id: 'network',        size: '2x1' },
  { id: 'nimtorrent',     size: '2x1' },
];

// ═══════════════════════════════════
// Add Widget Modal
// ═══════════════════════════════════

function AddWidgetModal({ currentWidgets, onAdd, onClose }) {
  const existing = new Set(currentWidgets.map(w => w.id));

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg-window, #1e1e23)', border: '1px solid var(--border, rgba(255,255,255,0.1))',
        borderRadius: 16, padding: 24, width: 380, maxWidth: '90%',
        boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-medium)', marginBottom: 16, color: 'var(--text-primary)' }}>
          Add Widget
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {Object.entries(WIDGET_REGISTRY).map(([id, reg]) => {
            const alreadyAdded = existing.has(id);
            return (
              <div
                key={id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 12px', borderRadius: 10,
                  background: alreadyAdded ? 'transparent' : 'var(--bg-card, rgba(255,255,255,0.03))',
                  border: '1px solid var(--border, rgba(255,255,255,0.06))',
                  cursor: alreadyAdded ? 'default' : 'pointer',
                  opacity: alreadyAdded ? 0.35 : 1,
                  transition: 'background 0.15s',
                }}
                onClick={() => {
                  if (!alreadyAdded) {
                    onAdd(id, reg.sizes[0]);
                    onClose();
                  }
                }}
                onMouseEnter={e => { if (!alreadyAdded) e.currentTarget.style.background = 'var(--bg-hover, rgba(255,255,255,0.06))'; }}
                onMouseLeave={e => { if (!alreadyAdded) e.currentTarget.style.background = 'var(--bg-card, rgba(255,255,255,0.03))'; }}
              >
                <span style={{ fontSize: 22 }}>{reg.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)' }}>
                    {reg.label}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    {reg.sizes.map(s => s.replace('x', '×')).join(' · ')}
                  </div>
                </div>
                {alreadyAdded && (
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Added</span>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button
            onClick={onClose}
            style={{
              padding: '6px 16px', fontSize: 'var(--text-sm)',
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 8, color: 'var(--text-secondary)', cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════
// DynamicWidgets
// ═══════════════════════════════════

export default function DynamicWidgets() {
  const { openWindow } = useWindows();
  const { widgetMode, widgetLayout, resizeWidget, removeWidgetFromLayout, addWidgetToLayout } = useTheme();
  const [showAddModal, setShowAddModal] = useState(false);
  const [editMode, setEditMode] = useState(false);

  if (widgetMode === 'off') return null;

  const isClassic = widgetMode === 'classic';
  const activeWidgets = widgetLayout || DEFAULT_WIDGETS;
  const widgets = isClassic ? activeWidgets.map(w => ({ ...w, size: '1x1' })) : activeWidgets;

  const renderWidget = (widget) => {
    const reg = WIDGET_REGISTRY[widget.id];
    if (!reg) return null;

    const Comp = reg.component;
    const effectiveSize = isClassic ? '1x1' : widget.size;

    const appMap = {
      'system-monitor': 'monitor',
      'disk-pool':      'nimsettings',
      'network':        'nimsettings',
      'nimtorrent':     'nimtorrent',
    };

    const handleClick = appMap[widget.id]
      ? () => openWindow(appMap[widget.id], { width: 960, height: 640 })
      : undefined;

    return (
      <Comp
        size={effectiveSize}
        onClick={handleClick}
        // Menu props passed through to WidgetCard
        widgetId={widget.id}
        availableSizes={reg.sizes}
        onResize={resizeWidget}
        onRemove={removeWidgetFromLayout}
        onAddWidget={() => setShowAddModal(true)}
        onEditGrid={() => setEditMode(!editMode)}
      />
    );
  };

  return (
    <>
      <WidgetGrid
        widgets={widgets}
        columns={isClassic ? 1 : 4}
        mode={widgetMode}
        renderWidget={renderWidget}
      />
      {showAddModal && (
        <AddWidgetModal
          currentWidgets={activeWidgets}
          onAdd={addWidgetToLayout}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </>
  );
}

export { WIDGET_REGISTRY, DEFAULT_WIDGETS };
