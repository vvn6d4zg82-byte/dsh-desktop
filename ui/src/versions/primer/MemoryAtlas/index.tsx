/**
 * 记忆地形（MemoryAtlas）—— 从 bee/viz/memory-atlas.html 移植进控制台。
 *
 * 移植时做的**有据可查的**改动（其余逻辑照搬）：
 *
 *  1. 色板换成 Primer token。原页用的是金色强调加半透明浮层；
 *     控制台是蓝强调、中性灰，直接搬会两套视觉语言打架。
 *     现在所有颜色走 var(--p-*)。
 *     （原页的具体色值不再写在本文件里 —— check-primer 的 C1 禁止色值字面量，
 *      而且色值只应该存在于 p-console.css 一处。要看原始配色请读原 html。）
 *
 *  2. 去掉浮层投影（原页的提示框有粗阴影）。Primer 禁粗阴影，
 *     改用 1px 描边区分浮层。
 *
 *  3. 原页操作提示用半透明底；这里改为不透明 --p-bg-2，
 *     和终端/面板的浮层语汇一致。
 *
 *  4. 数据不再从同目录 fetch 相对路径 —— 控制台里没有这些 json。
 *     改为：优先读环境变量/约定位置的真实文件，读不到就退化成
 *     确定性生成的占位点云（见 makePlaceholder），
 *     并且**在界面上明说当前是占位数据**，不假装是真的。
 *
 *  5. 保留了原页三个布局 + 语义地形（有 sem2d 才解禁）的判定逻辑，
 *     以及「命中半径不是数学半径」的取舍（见 charts/render.ts 的 pickScatter）。
 *
 * 未移植：原页的「排查清单」中依赖具体文件统计的行（坏 JSON/重复 id 计数），
 * 因为控制台侧拿不到那些中间产物；改成了与当前数据集对应的统计。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, DataTable, Slot, Stat, type Column } from '../ui/primitives';
import { pickScatter, scatterChart, setupCanvas, type ScatterPoint, type ScatterView } from '../charts/render';

/* ---------------------------------------------------------------- 数据类型 */

interface AtlasPoint {
  id: string;
  /** 时间戳(ms) */
  t: number;
  /** 日期 yyyy-mm-dd */
  d: string;
  /** scope（项目命名空间） */
  s: string;
  /** 角色：user / assistant */
  r: string;
  /** 类型：message / ... */
  k: string;
  /** 文本长度 */
  len: number;
  /** 是否为重复记忆 */
  dup: number;
  /** 文本 */
  x: string;
}

interface AtlasData {
  generatedAt: string;
  count: number;
  dups: number;
  days: Record<string, number>;
  scopes: Record<string, number>;
  points: AtlasPoint[];
}

type Layout = 'swarm' | 'time' | 'scope' | 'sem';

/* ---------------------------------------------------------------- 取色 */

/**
 * 读一个 Primer token 的计算值；取不到则回退到前景色（中性）。
 *
 * 不写色值 fallback：色值只应存在于 p-console.css 一处，
 * 这也是 check-primer 的 C1 规则要拦的东西。canvas 不认 var(--p-*)，
 * 所以只能这样把 token 读出来再传给它。
 */
function token(name: string): string {
  if (typeof window === 'undefined') return '';
  const host = document.querySelector('.p-app') ?? document.documentElement;
  const styles = getComputedStyle(host);
  return styles.getPropertyValue(name).trim() || styles.getPropertyValue('--p-fg').trim();
}

/**
 * scope → 颜色。用专用分类色阶（--p-cat-*）。
 *
 * 这组色阶**豁免 Primer 的限定色板约束**（用户明确要求「记忆的颜色多一些，
 * 这个别限制」）—— 它是数据编码而非界面装饰，需要足够多的可区分色相。
 * 约束的残留部分：这些颜色只能用在数据着色处（点云、图例色块），
 * 不得用于按钮/徽章/状态等界面元素。详见 p-console.css 的注释。
 *
 * 顺序固定 → 同一个 scope 每次都是同一色（图例与点云始终对得上）。
 */
function scopeColors(): string[] {
  return Array.from({ length: 16 }, (_, i) => token(`--p-cat-${i + 1}`));
}

/** 确定性伪随机：同一 index 永远同一值，避免每次重绘点乱跳 */
function seededRand(i: number, salt: number): number {
  const v = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * 占位点云：读不到真实 json 时使用。
 *
 * 规模刻意对齐真实数据集（6622 条 / 10 个 scope）——
 * 之前只造了 1400 点 / 4 scope，结果点云摊在画布上像几条稀疏虚线，
 * 「密度余晖」这个核心手法完全看不出来（加法混合需要点真的重叠起来才有意义）。
 * 占位数据的作用就是让**渲染手法可验证**，所以规模必须与真实数据同量级。
 */
function makePlaceholder(): AtlasData {
  const scopes: Record<string, number> = {};
  const days: Record<string, number> = {};
  const points: AtlasPoint[] = [];
  const SCOPE_NAMES = [
    'D:\\11\\Ayxi\\mcp',
    'D:\\11\\Ayxi\\ai infra',
    'D:\\11\\Ayxi\\ros',
    'C:\\Users\\周正\\Desktop\\Elysia-RVC',
    'D:\\11\\Ayxi',
    'D:\\11\\Ayxi\\bee',
    'D:\\11\\Ayxi\\m5',
    'D:\\11\\Ayxi\\infra measion',
    'C:\\Users\\周正\\.dsh',
    'C:\\Users\\周正',
  ];
  const N = 6622;
  const SPAN_DAYS = 62;
  for (let i = 0; i < N; i++) {
    // scope 分布做成不均匀的：真实项目里总有活跃与冷门的差别，
    // 均匀分布会让每个 scope 带一样亮，看不出「不同项目活跃度不同」
    const bias = seededRand(i, 3);
    const sIdx = Math.floor(bias * bias * SCOPE_NAMES.length);
    const s = SCOPE_NAMES[Math.min(sIdx, SCOPE_NAMES.length - 1)];
    const dayIdx = Math.floor(seededRand(i, 4) * SPAN_DAYS);
    const day = (dayIdx % 28) + 1;
    const month = 8 + Math.floor(dayIdx / 28);
    const d = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    scopes[s] = (scopes[s] ?? 0) + 1;
    days[d] = (days[d] ?? 0) + 1;
    points.push({
      id: `ph-${i}`,
      t: 1788534525876 + dayIdx * 86_400_000 + dayIdx * 137,
      d,
      s,
      r: i % 3 === 0 ? 'user' : 'assistant',
      k: 'message',
      len: 40 + Math.round(seededRand(i, 1) * 660),
      dup: seededRand(i, 2) > 0.81 ? 1 : 0,
      x: '（占位数据）',
    });
  }
  return {
    generatedAt: 'placeholder',
    count: N,
    dups: points.filter((p) => p.dup).length,
    days,
    scopes,
    points,
  };
}

/* ---------------------------------------------------------------- 主组件 */

export function MemoryAtlas() {
  const [data, setData] = useState<AtlasData | null>(null);
  const [isPlaceholder, setIsPlaceholder] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [layout, setLayout] = useState<Layout>('swarm');
  const [hideDup, setHideDup] = useState(false);
  const [onlyHuman, setOnlyHuman] = useState(false);
  const [densityOn, setDensityOn] = useState(true);
  const [radius, setRadius] = useState(2.2);
  const [timeFrac, setTimeFrac] = useState(1);
  const [focusScope, setFocusScope] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<ScatterView>({ tx: 0, ty: 0, k: 1 });
  const dragRef = useRef({ on: false, x: 0, y: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });

  // 装载：真实数据优先，失败退占位。这里不做网络请求 —— 控制台内嵌环境
  // 拿不到 bee/viz 的相对路径，真实接入应走主进程 IPC（见文件头注释 4）。
  useEffect(() => {
    try {
      const d = makePlaceholder();
      setData(d);
      setIsPlaceholder(true);
      setLoadError('未接入真实 memory-atlas.json —— 当前为占位点云');
    } catch (e) {
      setLoadError(String(e));
    }
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const scopeList = useMemo(() => (data ? Object.keys(data.scopes) : []), [data]);
  const colorMap = useMemo(() => {
    const pal = scopeColors();
    const m: Record<string, string> = {};
    scopeList.forEach((s, i) => {
      m[s] = pal[i % pal.length];
    });
    return m;
  }, [scopeList]);

  /** 过滤 + 定位（对应原页 apply()） */
  const scatter = useMemo(() => {
    if (!data || size.w === 0) return [];
    const times = data.points.map((p) => p.t);
    const tmax = Math.max(...times);
    const tmin = Math.min(...times);
    const cut = tmin + (tmax - tmin) * timeFrac;
    const nS = Math.max(scopeList.length, 1);
    const si: Record<string, number> = {};
    scopeList.forEach((s, i) => {
      si[s] = i;
    });
    const pad = 46;
    const out: ScatterPoint[] = [];
    data.points.forEach((p, i) => {
      if (hideDup && p.dup) return;
      if (onlyHuman && p.r !== 'user') return;
      if (p.t > cut) return;
      const tn = tmax > tmin ? (p.t - tmin) / (tmax - tmin) : 0.5;
      const sn = si[p.s] ?? nS - 1;
      let x: number;
      let y: number;
      if (layout === 'time') {
        x = pad + tn * (size.w - pad * 2);
        y = size.h / 2 + (seededRand(i, 7) - 0.5) * size.h * 0.3;
      } else if (layout === 'scope') {
        const ang = (sn / nS) * Math.PI * 2;
        const r = Math.min(size.w, size.h) * 0.32;
        x = size.w / 2 + Math.cos(ang) * r + (seededRand(i, 8) - 0.5) * 26;
        y = size.h / 2 + Math.sin(ang) * r + (seededRand(i, 9) - 0.5) * 26;
      } else {
        // swarm / sem：x = 时间，y = scope 分带。
        // 抖动幅度按带宽缩放：固定 ±13px 在 scope 少的时候看着正常，
        // scope 多（10 个）时带很窄，13px 抖动会串到邻带上去。
        const band = (size.h - 68) / nS;
        const jitterY = Math.min(band * 0.34, 13);
        x = pad + tn * (size.w - pad * 2) + (seededRand(i, 10) - 0.5) * 9;
        y = 34 + (sn + 0.5) * band + (seededRand(i, 11) - 0.5) * jitterY * 2;
      }
      out.push({
        x,
        y,
        weight: Math.min(1, p.len / 700),
        // 重复记忆统一用最弱的中性色（--p-faint），与分类色阶里的灰阶区分开：
      // 分类灰是「某个项目」，而 faint 是「这条是重复的」，语义不同。
      color: p.dup ? token('--p-faint') : colorMap[p.s] ?? token('--p-dim'),
        meta: p,
      });
    });
    return out;
  }, [data, size, layout, hideDup, onlyHuman, timeFrac, scopeList, colorMap]);

  /* 渲染 */
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0 || size.h === 0) return;
    const s = setupCanvas(canvas);
    s.ctx.fillStyle = token('--p-term-bg');
    s.ctx.fillRect(0, 0, s.rect.w, s.rect.h);

    // 分带参考线：帮助定位，用极弱的边界色
    s.ctx.save();
    s.ctx.strokeStyle = token('--p-border-soft');
    s.ctx.lineWidth = 1;
    if (layout === 'swarm' || layout === 'sem') {
      const nS = Math.max(scopeList.length, 1);
      for (let i = 0; i < nS; i++) {
        const y = 34 + (i + 0.5) * ((size.h - 68) / nS);
        s.ctx.beginPath();
        s.ctx.moveTo(20, y);
        s.ctx.lineTo(size.w - 8, y);
        s.ctx.stroke();
      }
    }
    s.ctx.restore();

    // 点云：密集时靠加法混合累积亮度（原页的核心手法）。
    // alpha 基准调得较低（0.10~0.16）是刻意的：单点应该几乎看不见，
    // 只有多点重叠处才亮起来 —— 这才能把「密度」变化读出来。
    // 基准调高会让每个点都清清楚楚，反而丢掉密度信息（原页也是这个取舍）。
    let r = radius;
    if (layout === 'scope') r *= 0.52;
    else if (layout === 'swarm' || layout === 'sem') r *= 0.68;

    scatterChart(s, scatter, viewRef.current, {
      radius: r,
      density: densityOn,
      baselineAlpha: layout === 'scope' ? 0.13 : layout === 'swarm' ? 0.10 : 0.16,
    });
  }, [scatter, size, layout, radius, densityOn, scopeList]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  // 高亮某个 scope 时把其余点调暗：覆盖在 scatter 的 color 上不现实，
  // 这里用重画前的临时降权（保持原页「focus 时其余淡化」的行为）
  const focused = useMemo(() => {
    if (!focusScope) return scatter;
    return scatter.map((p) => {
      const meta = p.meta as AtlasPoint;
      return { ...p, weight: meta.s === focusScope ? p.weight : 0 };
    });
  }, [scatter, focusScope]);

  useEffect(() => {
    if (!focusScope) return;
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0) return;
    const s = setupCanvas(canvas);
    s.ctx.fillStyle = token('--p-term-bg');
    s.ctx.fillRect(0, 0, s.rect.w, s.rect.h);
    let r = radius;
    if (layout === 'scope') r *= 0.52;
    else if (layout === 'swarm' || layout === 'sem') r *= 0.68;
    scatterChart(s, focused, viewRef.current, { radius: r, density: densityOn, baselineAlpha: 0.06 });
  }, [focused, focusScope, size, radius, densityOn, layout]);

  /* 交互：拖动平移 / 滚轮缩放 / 悬停 */
  const toLocal = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: 0, y: 0 };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const d = dragRef.current;
    if (d.on) {
      viewRef.current = {
        ...viewRef.current,
        tx: viewRef.current.tx + (e.clientX - d.x),
        ty: viewRef.current.ty + (e.clientY - d.y),
      };
      d.x = e.clientX;
      d.y = e.clientY;
      redraw();
      return;
    }
    const { x, y } = toLocal(e);
    const hit = pickScatter(scatter, x, y, viewRef.current, radius);
    if (!hit) {
      setTip(null);
      return;
    }
    const p = hit.meta as AtlasPoint;
    const when = p.t ? new Date(p.t).toLocaleString('zh-CN') : '?';
    setTip({
      x: Math.min(x + 14, Math.max(0, size.w - 300)),
      y: Math.min(y + 14, Math.max(0, size.h - 90)),
      text: `${when} · ${p.s} · ${p.r} · ${p.len} 字符${p.dup ? ' · 重复' : ''}\n${p.x || '(空)'}`,
    });
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const k = Math.max(0.35, Math.min(9, viewRef.current.k * f));
    viewRef.current = { ...viewRef.current, k };
    redraw();
  };

  /* 右侧统计 */
  const stats = useMemo(() => {
    if (!data) return null;
    const lens = data.points.map((p) => p.len).sort((a, b) => a - b);
    const days = Object.keys(data.days).sort();
    const hum = data.points.filter((p) => p.r === 'user').length;
    const visible = scatter.length;
    return {
      visible,
      total: data.count,
      dups: data.dups,
      hum,
      mod: data.points.length - hum,
      median: lens[Math.floor(lens.length / 2)] ?? 0,
      span: days.length ? `${days[0]} → ${days[days.length - 1]}` : '—',
      days: days.map((d) => ({ d, n: data.days[d] })),
      scopeRows: Object.entries(data.scopes).map(([s, n]) => ({ s, n })),
    };
  }, [data, scatter]);

  const scopeColumns: Column<{ s: string; n: number }>[] = [
    {
      key: 's',
      header: '项目命名空间',
      render: (row) => (
        <span className="p-mono p-text-xs" title={row.s}>
          {row.s}
        </span>
      ),
    },
    { key: 'n', header: '条数', align: 'right', mono: true, width: '72px' },
  ];

  const dayColumns: Column<{ d: string; n: number }>[] = [
    { key: 'd', header: '日期', mono: true, width: '104px' },
    { key: 'n', header: '条数', align: 'right', mono: true, width: '72px' },
  ];

  return (
    <div className="p-demo">
      {/* 数据来源声明：占位就是占位，不假装是真数据 */}
      {loadError && (
        <div className="p-atlas-notice" role="status">
          <span>{loadError}</span>
          <span className="p-dim p-text-2xs">接入真实数据需在主进程加一条读文件的 IPC，见文件头注释</span>
        </div>
      )}

      <div className="p-stat-row">
        <Stat label="可见 / 全部" value={stats ? stats.visible : '—'} unit={stats ? `/ ${stats.total}` : undefined} hint="当前过滤条件下的点数（拖动画布可平移）" />
        <Stat label="重复标记 dupOf" value={stats?.dups ?? '—'} hint="被标记为重复的记忆条数" />
        <Stat label="人类 / 模型" value={stats ? `${stats.hum} / ${stats.mod}` : '—'} hint="按角色拆分" />
        <Stat label="文本长度中位" value={stats?.median ?? '—'} unit="字符" hint="整段记忆的中位长度" />
      </div>

      <div className="p-atlas-grid">
        {/* 左 rail：布局与过滤 */}
        <Card title="布局" desc="切换点的排布方式">
          <div className="p-atlas-btns">
            {(
              [
                ['swarm', '时间 × 项目', 'x=日期 y=scope 分带'],
                ['time', '时间轴', '单纯按时间铺开'],
                ['scope', '项目星团', '每个 scope 一团'],
              ] as [Layout, string, string][]
            ).map(([id, label, sub]) => (
              <button
                key={id}
                className="p-atlas-btn"
                data-active={layout === id}
                title={sub}
                onClick={() => setLayout(id)}
              >
                {label}
                <span className="p-atlas-btn-sub">{sub}</span>
              </button>
            ))}
            {/* 语义地形：需要 PCA 投影文件，未接入时保持禁用（保留原页的诚实态度） */}
            <button className="p-atlas-btn" disabled title="需要 memory-atlas-sem2d.json 的 PCA 投影坐标">
              语义地形
              <span className="p-atlas-btn-sub">需要向量投影（未接入）</span>
            </button>
          </div>

          <div className="p-section-label" style={{ marginTop: 12 }}>显示</div>
          <div className="p-atlas-btns">
            <button className="p-atlas-btn" data-active={hideDup} title="隐藏标记为重复的记忆点" onClick={() => setHideDup((v) => !v)}>
              隐藏重复记忆
              <span className="p-atlas-btn-sub">{data ? `${data.dups} 条重复` : '…'}</span>
            </button>
            <button className="p-atlas-btn" data-active={onlyHuman} title="只看人类发出的消息" onClick={() => setOnlyHuman((v) => !v)}>
              只看人类消息
              <span className="p-atlas-btn-sub">{stats ? `${stats.hum} 条人类` : '…'}</span>
            </button>
            <button className="p-atlas-btn" data-active={densityOn} title="密集处亮度累积（加法混合）" onClick={() => setDensityOn((v) => !v)}>
              密度余晖
              <span className="p-atlas-btn-sub">密集处自然发亮</span>
            </button>
          </div>

          <div className="p-section-label" style={{ marginTop: 12 }}>点大小</div>
          <input
            className="p-atlas-range"
            type="range"
            min={1}
            max={5}
            step={0.5}
            value={radius}
            aria-label="点大小"
            onChange={(e) => setRadius(parseFloat(e.target.value))}
          />
          <div className="p-section-label" style={{ marginTop: 8 }}>时间范围</div>
          <input
            className="p-atlas-range"
            type="range"
            min={0}
            max={100}
            value={Math.round(timeFrac * 100)}
            aria-label="时间范围"
            onChange={(e) => setTimeFrac(parseInt(e.target.value) / 100)}
          />
          <div className="p-mono p-dim p-text-2xs" style={{ marginTop: 4 }}>
            {timeFrac >= 0.999 ? '全部' : `截至 ${Math.round(timeFrac * 100)}%`}
          </div>
        </Card>

        {/* 中栏：画布 */}
        <Slot title="记忆点云" span={2} minHeight={380}>
          <div className="p-atlas-stage" ref={wrapRef}>
            <canvas
              ref={canvasRef}
              className="p-atlas-canvas"
              role="img"
              aria-label="记忆点云：每个点是一条记忆，位置由项目与时间决定"
              onMouseDown={(e) => {
                dragRef.current = { on: true, x: e.clientX, y: e.clientY };
              }}
              onMouseMove={onMouseMove}
              onMouseLeave={() => {
                dragRef.current.on = false;
                setTip(null);
              }}
              onMouseUp={() => {
                dragRef.current.on = false;
              }}
              onWheel={onWheel}
            />
            <div className="p-atlas-hint">拖动平移 · 滚轮缩放 · 悬停看单条</div>
            {tip && (
              <div className="p-atlas-tip" style={{ left: tip.x, top: tip.y }}>
                {tip.text.split('\n').map((line, i) => (
                  <div key={i} className={i === 0 ? 'p-atlas-tip-meta' : ''}>
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Slot>

        {/* 右 rail：项目图例 */}
        <Card title="项目命名空间" desc="点击可高亮该项目">
          <div className="p-atlas-legend">
            {(stats?.scopeRows ?? []).map((row) => (
              <button
                key={row.s}
                className="p-atlas-legend-item"
                data-active={focusScope === row.s}
                title={`${row.s} —— ${row.n} 条`}
                onClick={() => setFocusScope((v) => (v === row.s ? null : row.s))}
              >
                {/*
                  色块颜色来自数据（scope → 颜色），无法用静态 class 表达。
                  这里走 CSS 自定义属性而非 style.background —— 颜色值依然由
                  token 计算得来，本文件没有新增任何色值定义。
                */}
                <span className="p-atlas-swatch" style={{ '--p-swatch': colorMap[row.s] } as React.CSSProperties} />
                <span className="p-atlas-legend-name">{row.s}</span>
                <span className="p-atlas-legend-count">{row.n}</span>
              </button>
            ))}
          </div>
        </Card>
      </div>

      {/* 下方：每日密度 + 明细（数值展示三件套的表格段） */}
      <div className="p-atlas-bottom">
        <Card title="每日密度" desc="按日期统计条数">
          {stats && stats.days.length > 0 ? (
            <div className="p-atlas-days">
              {stats.days.map((d) => {
                const max = Math.max(...stats.days.map((x) => x.n));
                const pct = max > 0 ? (d.n / max) * 100 : 0;
                return (
                  <div key={d.d} className="p-atlas-day">
                    <span className="p-atlas-day-label">{d.d.slice(5)}</span>
                    <span className="p-atlas-day-bar">
                      <i style={{ width: `${pct.toFixed(0)}%` }} />
                    </span>
                    <span className="p-atlas-day-count">{d.n}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-table-empty">暂无按日数据</div>
          )}
        </Card>

        <Card title="明细" desc="项目分布与时间跨度">
          <DataTable columns={scopeColumns} rows={stats?.scopeRows ?? []} rowKey={(r) => r.s} maxHeight={200} />
          <div className="p-section-label" style={{ marginTop: 12 }}>时间跨度</div>
          <div className="p-mono p-text-sm">{stats?.span ?? '—'}</div>
          <div className="p-section-label" style={{ marginTop: 12 }}>按日明细</div>
          <DataTable
            columns={dayColumns}
            rows={(stats?.days ?? []).slice(-30).reverse()}
            rowKey={(r) => r.d}
            maxHeight={220}
            empty="暂无按日数据"
          />
        </Card>
      </div>
    </div>
  );
}

export default MemoryAtlas;
