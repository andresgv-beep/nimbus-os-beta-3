import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@context';
import WidgetCard from './WidgetCard';

function formatRate(bytes) {
  if (!bytes || bytes === 0) return '0 B/s';
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
}

function WaveGraph({ data, color, height = 36 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data.length) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const max = Math.max(...data, 1);

    ctx.clearRect(0, 0, w, h);

    const points = data.length;
    const step = w / (points - 1 || 1);

    // Filled area
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < points; i++) {
      const x = i * step;
      const y = h - (data[i] / max) * (h * 0.85);
      if (i === 0) {
        ctx.lineTo(x, y);
      } else {
        const prevX = (i - 1) * step;
        const prevY = h - (data[i - 1] / max) * (h * 0.85);
        const cpx = (prevX + x) / 2;
        ctx.bezierCurveTo(cpx, prevY, cpx, y, x, y);
      }
    }
    ctx.lineTo(w, h);
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, color + '35');
    gradient.addColorStop(1, color + '05');
    ctx.fillStyle = gradient;
    ctx.fill();

    // Line stroke
    ctx.beginPath();
    for (let i = 0; i < points; i++) {
      const x = i * step;
      const y = h - (data[i] / max) * (h * 0.85);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        const prevX = (i - 1) * step;
        const prevY = h - (data[i - 1] / max) * (h * 0.85);
        const cpx = (prevX + x) / 2;
        ctx.bezierCurveTo(cpx, prevY, cpx, y, x, y);
      }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [data, color]);

  return (
    <canvas
      ref={canvasRef}
      width={280}
      height={height}
      style={{ width: '100%', height, display: 'block', borderRadius: 4 }}
    />
  );
}

function ArrowUp({ color, size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <path d="M12 4l-6 6h4v8h4v-8h4z" />
    </svg>
  );
}

function ArrowDown({ color, size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <path d="M12 20l6-6h-4V6h-4v8H6z" />
    </svg>
  );
}

export default function NetworkWidget({ size = '1x1', onClick }) {
  const { token } = useAuth();
  const [data, setData] = useState(null);
  const [history, setHistory] = useState({ rx: [], tx: [] });
  const MAX_POINTS = 30;

  useEffect(() => {
    if (!token) return;
    const headers = { 'Authorization': `Bearer ${token}` };
    const fetchStats = () => {
      fetch('/api/system', { headers })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (d) {
            const net = d.primaryNet || (Array.isArray(d.network) ? d.network[0] : null);
            setData(net);
            if (net) {
              setHistory(prev => ({
                rx: [...prev.rx.slice(-(MAX_POINTS - 1)), net.rxRate || 0],
                tx: [...prev.tx.slice(-(MAX_POINTS - 1)), net.txRate || 0],
              }));
            }
          }
        })
        .catch(() => {});
    };
    fetchStats();
    const iv = setInterval(fetchStats, 3000);
    return () => clearInterval(iv);
  }, [token]);

  const icon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
    </svg>
  );

  const dl = data?.rxRate || 0;
  const ul = data?.txRate || 0;

  const uploadColor = '#E95420';
  const downloadColor = '#42A5F5';

  // ─── 1×1 Compact ───
  if (size === '1x1') {
    return (
      <WidgetCard title="Network" icon={icon} size={size} onClick={onClick} loading={!data}>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', flex: 1, gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ArrowUp color={uploadColor} />
            <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-bold)', color: uploadColor }}>
              {formatRate(ul)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ArrowDown color={downloadColor} />
            <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-bold)', color: downloadColor }}>
              {formatRate(dl)}
            </span>
          </div>
        </div>
      </WidgetCard>
    );
  }

  // ─── 2×1 Wave Graph ───
  return (
    <WidgetCard title="Network" icon={icon} size={size} onClick={onClick} loading={!data}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 4 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ArrowUp color={uploadColor} size={10} />
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Upload</span>
            </div>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)', color: uploadColor }}>
              {formatRate(ul)}
            </span>
          </div>
          <WaveGraph data={history.tx} color={uploadColor} height={36} />
        </div>

        <div style={{ height: 1, background: 'var(--border)', margin: '2px 0' }} />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ArrowDown color={downloadColor} size={10} />
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Download</span>
            </div>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)', color: downloadColor }}>
              {formatRate(dl)}
            </span>
          </div>
          <WaveGraph data={history.rx} color={downloadColor} height={36} />
        </div>
      </div>
    </WidgetCard>
  );
}
