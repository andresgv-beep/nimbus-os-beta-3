import { useWindows, useTheme } from '@context';
import WidgetGrid from './WidgetGrid';
import ClockWidget from './ClockWidget';
import SystemMonitorWidget from './SystemMonitorWidget';
import DiskPoolWidget from './DiskPoolWidget';
import NetworkWidget from './NetworkWidget';
import UptimeWidget from './UptimeWidget';

// ═══════════════════════════════════
// Widget Registry
// Maps widget IDs to their components
// ═══════════════════════════════════

const WIDGET_REGISTRY = {
  'clock':          { component: ClockWidget,         label: 'Clock',          sizes: ['1x1'] },
  'system-monitor': { component: SystemMonitorWidget, label: 'System Monitor', sizes: ['2x1', '2x2'] },
  'disk-pool':      { component: DiskPoolWidget,      label: 'Disk Pool',      sizes: ['1x1', '2x1'] },
  'network':        { component: NetworkWidget,       label: 'Network',        sizes: ['1x1', '2x1'] },
  'uptime':         { component: UptimeWidget,        label: 'Uptime',         sizes: ['1x1'] },
};

// ═══════════════════════════════════
// Default widget layout (until user configures via NimSettings)
// ═══════════════════════════════════

const DEFAULT_WIDGETS = [
  { id: 'clock',          size: '1x1' },
  { id: 'disk-pool',      size: '1x1' },
  { id: 'system-monitor', size: '2x1' },
  { id: 'network',        size: '2x1' },
];

// ═══════════════════════════════════
// DynamicWidgets — renders on the desktop
// ═══════════════════════════════════

export default function DynamicWidgets() {
  const { openWindow } = useWindows();
  const { widgetMode } = useTheme();

  // Don't render if widgets are disabled
  if (widgetMode === 'off') return null;

  const isClassic = widgetMode === 'classic';

  // In classic mode, all widgets become 1x1 stacked vertically
  const widgets = isClassic
    ? DEFAULT_WIDGETS.map(w => ({ ...w, size: '1x1' }))
    : DEFAULT_WIDGETS;

  const renderWidget = (widget) => {
    const reg = WIDGET_REGISTRY[widget.id];
    if (!reg) return null;

    const Comp = reg.component;
    const effectiveSize = isClassic ? '1x1' : widget.size;

    const appMap = {
      'system-monitor': 'monitor',
      'disk-pool':      'nimsettings',
      'network':        'nimsettings',
    };

    const handleClick = appMap[widget.id]
      ? () => openWindow(appMap[widget.id], { width: 960, height: 640 })
      : undefined;

    return <Comp size={effectiveSize} onClick={handleClick} />;
  };

  return (
    <WidgetGrid
      widgets={widgets}
      columns={isClassic ? 1 : 4}
      mode={widgetMode}
      renderWidget={renderWidget}
    />
  );
}

// Export registry for NimSettings widget configurator
export { WIDGET_REGISTRY, DEFAULT_WIDGETS };
