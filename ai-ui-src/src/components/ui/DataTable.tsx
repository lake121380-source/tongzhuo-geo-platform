import React from 'react';
import { SkeletonRows } from '../Skeleton';

/**
 * 数据表（Design System · D0）。
 *
 * 审计发现表头有 **6 种写法**（`text-slate-500` / `border-b` / `uppercase` / `bg-slate-900` …），
 * 行高、悬停态、选中态各页面自定；空态有的写「暂无数据」、有的写「没有找到符合条件的内容」。
 *
 * 约定（统一到这一处）：
 *   - 表头：一行浅底 + 语义色小字，**不用 uppercase/tracking**（中文下那是噪音）
 *   - 加载中：骨架行（**绝不用空态冒充加载**）
 *   - 空：由调用方传 EmptyState（这样每张表的空态都有"下一步"）
 *   - 选择列：只在传了选择回调时出现
 */

export interface DataTableColumn<T> {
  key: string;
  header: React.ReactNode;
  /** 单元格渲染；缺省时取 `(row as Record)[key]`。 */
  render?: (row: T) => React.ReactNode;
  className?: string;
  headerClassName?: string;
  width?: string;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** 首轮数据未到：渲染骨架行。 */
  loading?: boolean;
  /** 空态节点（推荐 EmptyState；表内嵌时用 compact 版）。 */
  empty?: React.ReactNode;
  onRowClick?: (row: T) => void;
  selectedKeys?: Set<string>;
  onToggleRow?: (key: string) => void;
  onToggleAll?: () => void;
  allSelected?: boolean;
  /** 某些行不可选（如"需超管恢复"的回收站行）。 */
  rowSelectable?: (row: T) => boolean;
  /** 行高：默认 3.5（舒适）；紧凑列表用 2.5。 */
  dense?: boolean;
  className?: string;
  /** 表格右上角/外部的说明（如"共 N 条"）。 */
  caption?: React.ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  empty,
  onRowClick,
  selectedKeys,
  onToggleRow,
  onToggleAll,
  allSelected = false,
  rowSelectable,
  dense = false,
  className = '',
  caption,
}: DataTableProps<T>) {
  const selectable = Boolean(onToggleRow);
  const cellY = dense ? 'py-2' : 'py-3';
  const colSpan = columns.length + (selectable ? 1 : 0);

  return (
    <div className={`overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/80 shadow-sm ${className}`}>
      {caption && <div className="border-b border-slate-800 px-4 py-2.5 text-[11px] text-slate-400">{caption}</div>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs text-slate-300">
          <thead className="border-b border-slate-800 bg-slate-800/50 text-[11px] font-semibold text-slate-400">
            <tr>
              {selectable && (
                <th className="w-10 px-4 py-2.5">
                  <input
                    type="checkbox"
                    className="accent-indigo-500"
                    checked={allSelected}
                    onChange={() => onToggleAll?.()}
                    aria-label="选择当前列表全部"
                  />
                </th>
              )}
              {columns.map((column) => (
                <th
                  key={column.key}
                  style={column.width ? { width: column.width } : undefined}
                  className={`px-3 py-2.5 font-semibold ${column.headerClassName ?? ''}`}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {loading ? (
              <tr>
                <td colSpan={colSpan} className="px-6 py-8">
                  <SkeletonRows rows={4} />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="px-4 py-2">
                  {empty ?? <p className="py-8 text-center text-xs text-slate-400">暂无数据</p>}
                </td>
              </tr>
            ) : rows.map((row) => {
              const key = rowKey(row);
              const selectableRow = selectable && (rowSelectable ? rowSelectable(row) : true);
              return (
                <tr
                  key={key}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={`transition hover:bg-slate-800/40 ${onRowClick ? 'cursor-pointer' : ''} ${selectedKeys?.has(key) ? 'bg-indigo-500/5' : ''}`}
                >
                  {selectable && (
                    <td className={`${cellY} px-4`} onClick={(event) => event.stopPropagation()}>
                      {selectableRow && (
                        <input
                          type="checkbox"
                          className="accent-indigo-500"
                          checked={selectedKeys?.has(key) ?? false}
                          onChange={() => onToggleRow?.(key)}
                          aria-label="选择这一行"
                        />
                      )}
                    </td>
                  )}
                  {columns.map((column) => (
                    <td key={column.key} className={`${cellY} px-3 ${column.className ?? ''}`}>
                      {column.render ? column.render(row) : String((row as Record<string, unknown>)[column.key] ?? '')}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
