/**
 * Primer 基础件（本项目自用，不引入额外组件库）
 *
 * 只做「结构 + Primer 视觉」，不做业务。所有类名 p- 前缀、颜色走 var(--p-*)，
 * 以满足 scripts/check-primer.mjs 的硬门禁。
 */
import type { ReactNode } from 'react';

/* ------------------------------------------------------------------ 区块卡片 */

export function Card({
  title,
  desc,
  icon,
  actions,
  children,
  className,
}: {
  title: string;
  desc?: string;
  icon?: ReactNode;
  /** 卡片头右侧的次要操作 */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`p-card ${className ?? ''}`.trim()}>
      <header className="p-card-head">
        {icon && <span className="p-card-ic">{icon}</span>}
        <div className="min-w-0 flex-1">
          <h2 className="p-card-title">{title}</h2>
          {desc && <p className="p-card-desc truncate">{desc}</p>}
        </div>
        {actions && <div className="p-card-actions">{actions}</div>}
      </header>
      <div className="p-card-body">{children}</div>
    </section>
  );
}

/** 区块内的小标题：用于把一张卡片切成若干段 */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="p-section-label">{children}</div>;
}

/* ------------------------------------------------------------------ 数值单元 */

export type StatTone = 'default' | 'accent' | 'success' | 'attention' | 'danger';

/**
 * 单个数值展示单元 —— 「数值展示类」界面的最小积木。
 * 注意数字一律走等宽字体：数值要能上下对齐比较，比例字体做不到。
 */
export function Stat({
  label,
  value,
  unit,
  hint,
  tone = 'default',
  delta,
}: {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  tone?: StatTone;
  /** 相对上一周期的变化，例如 '+3' / '-12%'；tone 决定着色 */
  delta?: { text: string; tone: StatTone };
}) {
  return (
    <div className="p-stat" title={hint ?? label}>
      <div className="p-stat-label">{label}</div>
      <div className={`p-stat-value ${tone === 'default' ? '' : tone}`.trim()}>
        <span className="p-stat-num">{value}</span>
        {unit && <span className="p-stat-unit">{unit}</span>}
      </div>
      {(hint || delta) && (
        <div className="p-stat-foot">
          {delta && <span className={`p-stat-delta ${delta.tone === 'default' ? '' : delta.tone}`.trim()}>{delta.text}</span>}
          {hint && <span className="p-stat-hint">{hint}</span>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 明细表 */

export interface Column<Row> {
  key: string;
  /** 列头 */
  header: string;
  /** 单元格渲染；不传则直接取 row[key] */
  render?: (row: Row, index: number) => ReactNode;
  /** 右对齐（数值列用） */
  align?: 'left' | 'right';
  /** 等宽字体（数值/时间/ID 列用） */
  mono?: boolean;
  width?: string;
}

/**
 * 明细表 —— 「数值展示类」界面的第三个积木。
 * 纯 table 实现，不做虚拟滚动：数值面板的行数通常可控，
 * 真到万行的场景应该分页或换虚拟列表（那是另一个决定）。
 */
export function DataTable<Row extends Record<string, unknown>>({
  columns,
  rows,
  rowKey,
  empty = '暂无数据',
  maxHeight,
}: {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row, index: number) => string;
  empty?: string;
  maxHeight?: number;
}) {
  if (rows.length === 0) {
    return <div className="p-table-empty">{empty}</div>;
  }
  return (
    <div className="p-table-wrap" style={maxHeight ? { maxHeight } : undefined}>
      <table className="p-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.align === 'right' ? 'is-right' : ''} style={c.width ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)}>
              {columns.map((c) => (
                <td key={c.key} className={`${c.align === 'right' ? 'is-right' : ''} ${c.mono ? 'p-mono' : ''}`.trim()}>
                  {c.render ? c.render(row, i) : String(row[c.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ 插槽 */

/**
 * 预设位置（插槽）—— 本轮的核心诉求。
 *
 * 以后每加一个演示界面，就往这些固定位置上填内容：结构、留白、栅格都由
 * 外壳决定，演示界面只负责提供数字，于是所有数值界面长得一致。
 * 未接数据时显示占位说明，而不是空白 —— 空着看不出来是「没做」还是「没数据」。
 */
export function Slot({
  title,
  span = 1,
  minHeight,
  children,
}: {
  title: string;
  /** 占几列（外壳栅格为 12 列的倍数，见 .p-slot-grid） */
  span?: 1 | 2 | 3 | 4 | 'full';
  minHeight?: number;
  children?: ReactNode;
}) {
  const spanClass = span === 'full' ? 'is-full' : `span-${span}`;
  const empty = children === undefined || children === null;
  return (
    <div
      className={`p-slot ${spanClass}`}
      style={minHeight ? { minHeight } : undefined}
      title={empty ? `${title}（位置已预留给后续演示界面）` : title}
    >
      <div className="p-slot-head">
        <span className="p-slot-title">{title}</span>
        {empty && <span className="p-slot-tag">待接入</span>}
      </div>
      <div className="p-slot-body">
        {empty ? <div className="p-slot-empty">此位置已预留，后续演示界面的数值将填在这里。</div> : children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 开关 */

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
      className="p-switch"
    >
      <span className="p-thumb" />
    </button>
  );
}

/** 设置行：左标签（可带描述）+ 右控件 */
export function SettingRow({
  icon,
  label,
  description,
  children,
  layout = 'inline',
}: {
  icon?: ReactNode;
  label: string;
  description?: string;
  children: ReactNode;
  /**
   * 布局模式：
   *   inline —— 左标签 / 右控件（默认，适合开关这类窄控件）
   *   stacked —— 标签在上、控件在下占满整行（适合输入框 + 按钮组这类宽控件）
   *
   * 为什么需要 stacked：inline 模式下 `.p-set-ctrl` 是 flex-shrink:0，
   * 当控件里有 min-width:200px 的输入框时，它会抢走整行宽度，
   * 把左侧标签列压到 0px —— 表现为描述文字「一字一行」竖着排下来。
   * 凡是控件宽度不确定（输入框、多按钮、地址）的行，都必须用 stacked。
   */
  layout?: 'inline' | 'stacked';
}) {
  if (layout === 'stacked') {
    return (
      <div className="p-set-row is-stacked">
        <div className="p-set-main">
          {icon && <span className="p-set-ic">{icon}</span>}
          <div className="min-w-0">
            <div className="p-set-label">{label}</div>
            {description && <p className="p-set-desc">{description}</p>}
          </div>
        </div>
        <div className="p-set-ctrl">{children}</div>
      </div>
    );
  }
  return (
    <div className="p-set-row">
      <div className="p-set-main">
        {icon && <span className="p-set-ic">{icon}</span>}
        <div className="min-w-0">
          <div className="p-set-label">{label}</div>
          {description && <p className="p-set-desc">{description}</p>}
        </div>
      </div>
      <div className="p-set-ctrl">{children}</div>
    </div>
  );
}
