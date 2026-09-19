/**
 * 设计系统组件（Design System · D0）。
 *
 * 为什么要有一层 `ui/`：审计发现同一个"按钮/卡片/弹窗/表格/空态"在全站各有 3~8 种写法，
 * 修复它们不是"改 CSS"，而是**把重复的发明收成一个组件**。页面从此只组合组件，
 * 不再自己拼样式——这样一致性不需要靠人盯。
 *
 * 用法：`import { Button, Card, Section, DataTable, Modal, Drawer, EmptyState, useToast, useConfirm, Field, Input, Select, Textarea } from './ui';`
 */
export { Button, IconButton } from './Button';
export type { ButtonVariant, ButtonSize } from './Button';
export { Card, Section } from './Card';
export { EmptyState } from './EmptyState';
export { DataTable } from './DataTable';
export type { DataTableColumn } from './DataTable';
export { Modal, Drawer } from './Modal';
export { ToastProvider, useToast } from './Toast';
export { ConfirmProvider, useConfirm } from './ConfirmDialog';
export { Field, Input, Select, Textarea } from './Field';
export { Sparkline, BarList, TrendChart } from './Chart';
export { TabbedShell } from './TabbedShell';
export type { ShellTab } from './TabbedShell';
