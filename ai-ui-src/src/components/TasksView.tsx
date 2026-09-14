import React, { useEffect, useRef, useState } from 'react';
import { Workflow, Plus, Play, RefreshCw, Square, Pencil, Trash2, AlertTriangle, Server, ShieldCheck, ChevronDown, Wrench, Sparkles } from 'lucide-react';
import { Task, Category, TaskTitleReadiness, TaskWorker } from '../types';
import { ApiRecord } from '../api/geoflowClient';
import { mapTaskTitleReadiness, mapTaskWorkers } from '../api/mappers';
import { hasScope } from '../api/permissions';
import PermissionNotice from './PermissionNotice';
import TaskMonitoringPanel from './TaskMonitoringPanel';
import { StatusBadge, jobStatusSpec } from './StatusBadge';
import { SkeletonRows } from './Skeleton';
import { PageHeader } from './PageHeader';
import { EmptyState } from './ui';

interface TasksViewProps {
  tasks: Task[];
  categories: Category[];
  onCreateTask: (task: Partial<Task> & Record<string, unknown>) => void | Promise<void>;
  onRunTask: (taskId: string) => Promise<void>;
  onStopTask?: (taskId: string) => void | Promise<void>;
  onEnqueueTask?: (taskId: string) => void | Promise<void>;
  onUpdateTask?: (taskId: string, payload: Record<string, unknown>) => void | Promise<void>;
  onDeleteTask?: (taskId: string) => void | Promise<void>;
  onLoadWorkers?: () => Promise<ApiRecord>;
  /** 队列/Worker 健康快照与跨任务最近运行（旧后台 tasks/health-check 与 tasks/jobs）。 */
  onLoadHealth?: () => Promise<ApiRecord>;
  onLoadRecentRuns?: () => Promise<ApiRecord>;
  onLoadTrash?: (params?: Record<string, string | number | undefined>) => Promise<ApiRecord>;
  onRestoreTask?: (taskId: string, trashSequence: number) => void | Promise<void>;
  onCheckTitleReadiness?: (params: Record<string, string | number | undefined>) => Promise<ApiRecord>;
  /** 「AI 生成文章」：跳到文章页并直接打开生成弹窗（由 App 提供）。 */
  onOpenAiGenerate?: () => void;
  lang: 'zh' | 'en';
  apiMode?: boolean;
  scopes?: readonly string[];
  /** 首轮数据还在读取：任务区显示骨架而不是直接空白/空态。 */
  loading?: boolean;
  apiCatalog?: {
    titleLibraries: Array<{ id: string | number; name: string }>;
    prompts: Array<{ id: string | number; name: string }>;
    models: Array<{ id: string | number; name: string; type?: string }>;
    categories: Array<{ id: string | number; name: string }>;
    authors: Array<{ id: string | number; name: string }>;
    knowledgeBases: Array<{ id: string | number; name: string }>;
  };
}

export const TasksView: React.FC<TasksViewProps> = ({
  tasks,
  categories,
  onCreateTask,
  onRunTask,
  onStopTask,
  onEnqueueTask,
  onUpdateTask,
  onDeleteTask,
  onLoadWorkers,
  onLoadHealth,
  onLoadRecentRuns,
  onLoadTrash,
  onRestoreTask,
  onCheckTitleReadiness,
  onOpenAiGenerate,
  lang,
  apiMode = false,
  scopes = [],
  loading = false,
  apiCatalog,
}) => {
  const canReadTasks = !apiMode || hasScope(scopes, 'tasks:read');
  const canWriteTasks = !apiMode || hasScope(scopes, 'tasks:write');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [actionTaskId, setActionTaskId] = useState<string | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');

  // Form State
  const [name, setName] = useState('');
  const [targetCategory, setTargetCategory] = useState('科技资讯');
  const [aiModel, setAiModel] = useState('Gemini 2.5 Flash');
  // 桐灼GEO stores publish_interval in seconds.  The API form exposes a
  // human-friendly integer in minutes; keep the demo's text schedule separate
  // so a number input never receives the legacy "每天 08:00" value.
  const [schedule, setSchedule] = useState(() => (apiMode ? '60' : '每天 08:00'));
  const [batchLimit, setBatchLimit] = useState(3);
  const [titleLibraryId, setTitleLibraryId] = useState('');
  const [promptId, setPromptId] = useState('');
  const [aiModelId, setAiModelId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [authorId, setAuthorId] = useState('');
  const [knowledgeBaseId, setKnowledgeBaseId] = useState('');
  const [taskStatus, setTaskStatus] = useState<'active' | 'paused'>('paused');
  const [publishScope, setPublishScope] = useState('local_only');
  const [needReview, setNeedReview] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [isLoop, setIsLoop] = useState(false);
  const [workers, setWorkers] = useState<TaskWorker[]>([]);
  const [workersLoading, setWorkersLoading] = useState(false);
  const [workersError, setWorkersError] = useState('');
  const [workersUpdatedAt, setWorkersUpdatedAt] = useState('');
  const [readiness, setReadiness] = useState<TaskTitleReadiness | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [readinessError, setReadinessError] = useState('');
  const [taskActionErrors, setTaskActionErrors] = useState<Record<string, string>>({});
  const [trashedTasks, setTrashedTasks] = useState<ApiRecord[]>([]);
  const [trashPagination, setTrashPagination] = useState<ApiRecord>({});
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState('');
  const [restoringTrashId, setRestoringTrashId] = useState<string | null>(null);
  const workersLoaderRef = useRef(onLoadWorkers);
  const trashLoaderRef = useRef(onLoadTrash);
  const readinessCheckerRef = useRef(onCheckTitleReadiness);
  workersLoaderRef.current = onLoadWorkers;
  trashLoaderRef.current = onLoadTrash;
  readinessCheckerRef.current = onCheckTitleReadiness;

  useEffect(() => {
    // This component normally stays in one mode for its lifetime, but keeping
    // the state coherent also makes hot configuration/mode switches safe.
    setSchedule((current) => {
      if (apiMode && !/^\d+$/.test(current)) return '60';
      if (!apiMode && /^\d+$/.test(current)) return '每天 08:00';
      return current;
    });
    setFormError('');
  }, [apiMode]);

  useEffect(() => {
    if (!apiMode || !apiCatalog) return;
    if (!titleLibraryId && apiCatalog.titleLibraries.length > 0) {
      setTitleLibraryId(String(apiCatalog.titleLibraries[0].id));
    }
    if (!promptId && apiCatalog.prompts.length > 0) {
      setPromptId(String(apiCatalog.prompts[0].id));
    }
    // Only chat models can execute a content-generation task.  Do not fall
    // back to the first catalog item when a deployment exposes embedding
    // models only: that would create a task which the API rejects at runtime.
    const chatModels = apiCatalog.models.filter((model) => !model.type || model.type === 'chat');
    if (!aiModelId && chatModels.length > 0) {
      const selected = chatModels[0];
      setAiModelId(String(selected.id));
      setAiModel(selected.name);
    } else if (aiModelId && !chatModels.some((model) => String(model.id) === aiModelId)) {
      // Clear a selection removed or revoked while the modal was open.
      setAiModelId('');
      setAiModel('');
    }
    // Category, author, and knowledge base are optional in the 桐灼GEO
    // contract.  Leaving them empty preserves the server's smart-category,
    // default-author, and no-knowledge-base semantics instead of silently
    // binding the first catalog entry to every new task.
  }, [apiMode, apiCatalog, titleLibraryId, promptId, aiModelId, categoryId, authorId, knowledgeBaseId]);

  const refreshWorkers = async () => {
    const loader = workersLoaderRef.current;
    if (!apiMode || !loader) return;
    setWorkersLoading(true);
    setWorkersError('');
    try {
      const result = await loader();
      setWorkers(mapTaskWorkers(result));
      setWorkersUpdatedAt(new Date().toLocaleTimeString());
    } catch (error) {
      setWorkersError(error instanceof Error ? error.message : (lang === 'zh' ? '读取 Worker 状态失败' : 'Unable to read worker status'));
    } finally {
      setWorkersLoading(false);
    }
  };

  useEffect(() => {
    if (!apiMode || !canReadTasks || !onLoadWorkers) {
      setWorkers([]);
      setWorkersError('');
      return;
    }
    void refreshWorkers();
    const timer = window.setInterval(() => void refreshWorkers(), 30000);
    return () => window.clearInterval(timer);
  }, [apiMode, canReadTasks, lang]);

  const refreshTrash = async () => {
    const loader = trashLoaderRef.current;
    if (!apiMode || !canReadTasks || !loader) return;
    setTrashLoading(true);
    setTrashError('');
    try {
      const result = await loader({ page: 1, per_page: 50 });
      const rows = Array.isArray(result.items) ? result.items.map((item) => item && typeof item === 'object' ? item as ApiRecord : {}) : [];
      setTrashedTasks(rows);
      setTrashPagination((result.pagination && typeof result.pagination === 'object') ? result.pagination as ApiRecord : {});
    } catch (error) {
      setTrashError(error instanceof Error ? error.message : (lang === 'zh' ? '读取任务回收站失败' : 'Unable to load task trash'));
    } finally {
      setTrashLoading(false);
    }
  };

  useEffect(() => {
    if (!apiMode || !canReadTasks || !onLoadTrash) {
      setTrashedTasks([]);
      setTrashPagination({});
      setTrashError('');
      return;
    }
    void refreshTrash();
  }, [apiMode, canReadTasks, lang]);

  const handleRestoreTrash = async (item: ApiRecord) => {
    if (!onRestoreTask) return;
    const id = String(item.id || '');
    const sequence = Number(item.trash_sequence || 0);
    if (!id || !Number.isInteger(sequence) || sequence < 1) return;
    setRestoringTrashId(id);
    setTrashError('');
    try {
      await onRestoreTask(id, sequence);
      await refreshTrash();
    } catch (error) {
      setTrashError(error instanceof Error ? error.message : (lang === 'zh' ? '恢复任务失败' : 'Unable to restore task'));
    } finally {
      setRestoringTrashId(null);
    }
  };

  useEffect(() => {
    // A readiness report is tied to the exact title library, limit, loop mode,
    // and target status. Never show an old green report after the form changes.
    setReadiness(null);
    setReadinessError('');
  }, [titleLibraryId, batchLimit, isLoop, taskStatus, editingTask?.id]);

  const checkTitleReadiness = async (): Promise<TaskTitleReadiness | null> => {
    const checker = readinessCheckerRef.current;
    if (!apiMode || !checker) return null;
    const libraryId = Number(titleLibraryId);
    const limit = Number(batchLimit);
    if (!Number.isInteger(libraryId) || libraryId < 1 || !Number.isInteger(limit) || limit < 1) {
      const message = lang === 'zh' ? '请先选择标题库并填写有效的生成篇数。' : 'Select a title library and enter a valid article limit first.';
      setReadinessError(message);
      return null;
    }
    setReadinessLoading(true);
    setReadinessError('');
    try {
      const result = await checker({
        title_library_id: libraryId,
        article_limit: limit,
        is_loop: isLoop ? 1 : 0,
        status: taskStatus,
        ...(editingTask?.id ? { task_id: Number(editingTask.id) } : {}),
      });
      const report = mapTaskTitleReadiness(result);
      setReadiness(report);
      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : (lang === 'zh' ? '标题库就绪度检查失败' : 'Unable to check title readiness');
      setReadinessError(message);
      return null;
    } finally {
      setReadinessLoading(false);
    }
  };

  const readinessIssueLabel = (code: string): string => {
    const labels: Record<string, string> = {
      title_library_empty: lang === 'zh' ? '标题库为空' : 'Title library is empty',
      title_library_exhausted: lang === 'zh' ? '标题已耗尽' : 'Titles are exhausted',
      title_library_shortage: lang === 'zh' ? '可用标题不足' : 'Not enough available titles',
      title_library_shared: lang === 'zh' ? '有其他启用任务共用此标题库' : 'Another active task shares this library',
      loop_reuses_titles: lang === 'zh' ? '循环任务会复用已使用标题' : 'Loop mode will reuse used titles',
      title_library_missing: lang === 'zh' ? '标题库不存在' : 'Title library is missing',
    };
    return labels[code] || code;
  };

  const resetTaskForm = () => {
    setName('');
    setTargetCategory('科技资讯');
    setAiModel('Gemini 2.5 Flash');
    setSchedule(apiMode ? '60' : '每天 08:00');
    setBatchLimit(3);
    setTitleLibraryId(apiMode && apiCatalog?.titleLibraries[0]
      ? String(apiCatalog.titleLibraries[0].id)
      : '');
    setPromptId(apiMode && apiCatalog?.prompts[0] ? String(apiCatalog.prompts[0].id) : '');
    const chatModel = apiCatalog?.models.find((model) => !model.type || model.type === 'chat');
    setAiModelId(apiMode && chatModel ? String(chatModel.id) : '');
    setCategoryId('');
    setAuthorId('');
    setKnowledgeBaseId('');
    setTaskStatus('paused');
    setPublishScope('local_only');
    setNeedReview(true);
    setIsLoop(false);
  };

  const openCreateModal = () => {
    resetTaskForm();
    setEditingTask(null);
    setFormError('');
    setIsModalOpen(true);
  };

  const openEditModal = (task: Task) => {
    setEditingTask(task);
    setName(task.name || '');
    setTargetCategory(task.targetCategory || '科技资讯');
    setAiModel(task.aiModel || '');
    setSchedule(apiMode
      ? String(Math.max(1, Math.round((task.publishIntervalSeconds || 3600) / 60)))
      : (task.schedule || '每天 08:00'));
    setBatchLimit(Math.max(1, task.batchLimit || 1));
    setTitleLibraryId(task.titleLibraryId ? String(task.titleLibraryId) : '');
    setPromptId(task.promptId ? String(task.promptId) : '');
    setAiModelId(task.apiModelId ? String(task.apiModelId) : '');
    setCategoryId(task.apiCategoryId ? String(task.apiCategoryId) : '');
    setAuthorId(task.authorId ? String(task.authorId) : '');
    setKnowledgeBaseId(task.knowledgeBaseIds?.[0] ? String(task.knowledgeBaseIds[0]) : '');
    setTaskStatus(task.rawStatus === 'active' || task.status === 'running' ? 'active' : 'paused');
    setPublishScope(task.publishScope || (task.distributionScope === 'channels_only'
      ? 'distribution_only'
      : task.distributionScope === 'all' ? 'local_and_distribution' : 'local_only'));
    setNeedReview(task.needReview !== false);
    setIsLoop(task.isLoop === true);
    setFormError('');
    setIsModalOpen(true);
  };

  const closeTaskModal = () => {
    if (isSubmitting) return;
    setIsModalOpen(false);
    setEditingTask(null);
    setFormError('');
  };

  const requestDelete = (taskId: string) => {
    setDeleteError('');
    setDeletingTaskId(taskId);
  };

  const cancelDelete = () => {
    if (isSubmitting) return;
    setDeletingTaskId(null);
    setDeleteError('');
  };

  const handleDeleteConfirmed = async () => {
    if (!deletingTaskId || !onDeleteTask) return;
    setIsSubmitting(true);
    setDeleteError('');
    try {
      await onDeleteTask(deletingTaskId);
      setDeletingTaskId(null);
    } catch (error) {
      setDeleteError(error instanceof Error
        ? error.message
        : (lang === 'zh' ? '删除任务失败，请稍后重试。' : 'Unable to delete task. Please try again.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const displayLastRun = (value: string) => {
    const normalized = String(value || '').trim();
    return normalized ? normalized.split(' ')[0] : '—';
  };

  const checkTaskBeforeExecution = async (task: Task): Promise<boolean> => {
    const checker = readinessCheckerRef.current;
    if (!apiMode || !canReadTasks || !checker) return true;
    const libraryId = Number(task.titleLibraryId);
    const limit = Number(task.batchLimit);
    if (!Number.isInteger(libraryId) || libraryId < 1 || !Number.isInteger(limit) || limit < 1) {
      // Keep the server as the final authority for older tasks whose list
      // projection lacks dependency identifiers.
      return true;
    }
    setTaskActionErrors((current) => {
      const next = { ...current };
      delete next[task.id];
      return next;
    });
    try {
      const result = await checker({
        title_library_id: libraryId,
        article_limit: limit,
        is_loop: task.isLoop ? 1 : 0,
        status: 'active',
        task_id: Number(task.id),
      });
      const report = mapTaskTitleReadiness(result);
      if (!report.canActivate) {
        const message = report.issues.length > 0
          ? report.issues.map((issue) => readinessIssueLabel(issue.code)).join('；')
          : (lang === 'zh' ? '标题库就绪度未通过' : 'Title readiness is blocked');
        setTaskActionErrors((current) => ({ ...current, [task.id]: message }));
        return false;
      }
    } catch {
      // A monitoring/read-only request failing must not pretend the task is
      // ready. The mutation below still executes the server-side guard and
      // will return its authoritative error if activation is unsafe.
    }
    return true;
  };

  const handleRun = async (taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    setActionTaskId(taskId);
    if (task && !(await checkTaskBeforeExecution(task))) {
      setActionTaskId(null);
      return;
    }
    setRunningTaskId(taskId);
    try {
      await onRunTask(taskId);
    } finally {
      setRunningTaskId(null);
      setActionTaskId(null);
    }
  };

  const handleStop = async (taskId: string) => {
    if (!onStopTask) return;
    setActionTaskId(taskId);
    try {
      await onStopTask(taskId);
    } finally {
      setActionTaskId(null);
    }
  };

  const handleEnqueue = async (taskId: string) => {
    if (!onEnqueueTask) return;
    const task = tasks.find((item) => item.id === taskId);
    setActionTaskId(taskId);
    if (task && !(await checkTaskBeforeExecution(task))) {
      setActionTaskId(null);
      return;
    }
    try {
      await onEnqueueTask(taskId);
    } finally {
      setActionTaskId(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    const isEditing = Boolean(editingTask);
    if (!name.trim()) {
      setFormError(lang === 'zh' ? '请输入任务名称。' : 'Enter a task name.');
      return;
    }

    if (apiMode && !isEditing && (!titleLibraryId || !promptId || !aiModelId)) {
      setFormError(lang === 'zh' ? '请先选择标题库、内容提示词和内容模型。' : 'Select a title library, prompt, and content model first.');
      return;
    }

    const parsedBatchLimit = Number(batchLimit);
    if (!Number.isInteger(parsedBatchLimit) || parsedBatchLimit < 1 || parsedBatchLimit > 100) {
      setFormError(lang === 'zh' ? '单次生成篇数必须是 1-100 的整数。' : 'Batch count must be an integer from 1 to 100.');
      return;
    }

    let intervalMinutes = 0;
    if (apiMode) {
      intervalMinutes = Number(schedule);
      if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 43200) {
        setFormError(lang === 'zh'
          ? '执行频次必须是 1-43200 分钟的整数。'
          : 'Interval must be an integer from 1 to 43,200 minutes.');
        return;
      }
    }

    // The API remains the authority, but a successful preflight gives the
    // operator the same actionable title shortage/conflict details before a
    // status=active write is attempted. A failed read does not bypass the
    // server guard; the subsequent mutation still receives the authoritative
    // 4xx response.
    if (apiMode && canReadTasks && taskStatus === 'active' && onCheckTitleReadiness) {
      const report = await checkTitleReadiness();
      if (report && !report.canActivate) {
        setFormError(lang === 'zh'
          ? '标题库就绪度未通过，请处理下方阻断项后再启用任务。'
          : 'Title readiness is blocked. Resolve the issues below before activating the task.');
        return;
      }
    }

    setIsSubmitting(true);
    try {
      if (apiMode) {
        if (isEditing && editingTask && onUpdateTask) {
          const payload: Record<string, unknown> = {
            name: name.trim(),
            status: taskStatus,
            article_limit: parsedBatchLimit,
            draft_limit: parsedBatchLimit,
            publish_interval: intervalMinutes * 60,
            publish_scope: publishScope,
            need_review: needReview,
            is_loop: isLoop,
          };
          if (titleLibraryId) payload.title_library_id = Number(titleLibraryId);
          if (promptId) payload.prompt_id = Number(promptId);
          if (aiModelId) payload.ai_model_id = Number(aiModelId);
          if (categoryId) {
            payload.fixed_category_id = Number(categoryId);
            payload.category_mode = 'fixed';
          } else if (!editingTask.apiCategoryId) {
            payload.category_mode = 'smart';
          }
          if (authorId) payload.author_id = Number(authorId);
          if (knowledgeBaseId) payload.knowledge_base_ids = [Number(knowledgeBaseId)];
          /*
           * 上面这些字段（need_review / knowledge_base_ids / ai_model_id / publish_scope /
           * title_library_id / prompt_id）都在后端的「质检配置」清单里，改它们必须带上
           * 当前版本号做乐观并发，否则服务端一律 409
           * `task_ai_quality_config_version_required`——而界面上根本没有这个字段可填，
           * 用户看到的就是一句没有出路的报错。版本号来自任务投影的 `config_version`。
           */
          const configVersion = Number(editingTask.aiQualityConfigVersion) || 0;
          if (configVersion <= 0) {
            setFormError(lang === 'zh'
              ? '没读到这个任务的质检配置版本号，无法安全保存。请关闭弹窗、刷新页面后重试。'
              : 'Could not read this task\'s quality config version. Close the dialog, refresh and retry.');
            return;
          }
          payload.config_version = configVersion;
          await onUpdateTask(editingTask.id, payload);
        } else if (isEditing) {
          throw new Error(lang === 'zh' ? '任务编辑接口未配置' : 'Task update is not configured');
        } else {
          await onCreateTask({
            name: name.trim(),
            title_library_id: Number(titleLibraryId),
            prompt_id: Number(promptId),
            ai_model_id: Number(aiModelId),
            fixed_category_id: categoryId ? Number(categoryId) : null,
            author_id: authorId ? Number(authorId) : null,
            knowledge_base_ids: knowledgeBaseId ? [Number(knowledgeBaseId)] : [],
            status: 'paused',
            article_limit: parsedBatchLimit,
            draft_limit: parsedBatchLimit,
            publish_interval: intervalMinutes * 60,
            publish_scope: 'local_only',
            category_mode: categoryId ? 'fixed' : 'smart',
            need_review: true,
            ai_quality_enabled: false,
            is_loop: isLoop,
          });
        }
      } else {
        await onCreateTask({
          name,
          targetCategory,
          aiModel,
          schedule,
          batchLimit: Number(batchLimit) || 3,
          distributionScope: 'all',
        });
      }
      resetTaskForm();
      setEditingTask(null);
      setIsModalOpen(false);
    } catch (error) {
      // Form events do not consume a returned promise.  Catch here so a 422
      // or network failure stays visible in the modal instead of becoming an
      // unhandled rejection while the user's input remains intact.
      setFormError(error instanceof Error
        ? error.message
        : (lang === 'zh'
          ? (isEditing ? '更新任务失败，请稍后重试。' : '创建任务失败，请稍后重试。')
          : (isEditing ? 'Unable to update task. Please try again.' : 'Unable to create task. Please try again.')));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
    <div className="space-y-8">
      <PageHeader
        icon={Workflow}
        group={lang === 'zh' ? '内容中心' : 'Content'}
        title={lang === 'zh' ? '写文章' : 'Write'}
        description={lang === 'zh'
          ? '两种写法：想马上要一篇，点「AI 生成文章」（约 1 分钟出稿）；想让它按节奏自动写，就建一条流水线。'
          : 'Two ways to write: generate one article now, or set up a pipeline that keeps writing on schedule.'}
        actions={<>
          {/* 主操作：立刻生成一篇（复用文章页的生成弹窗，见 App 的 openAiGenerate） */}
          {onOpenAiGenerate && canWriteTasks && (
            <button
              onClick={onOpenAiGenerate}
              className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-[13px] font-bold text-white shadow-sm transition hover:bg-indigo-500"
            >
              <Sparkles className="w-4 h-4" />
              <span>{lang === 'zh' ? 'AI 生成文章' : 'Generate now'}</span>
            </button>
          )}
          {canWriteTasks ? (
            <button
              onClick={openCreateModal}
              className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-2.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800"
            >
              <Plus className="w-4 h-4" />
              <span>{lang === 'zh' ? '新建生成任务' : 'New Task'}</span>
            </button>
          ) : apiMode ? (
            <PermissionNotice lang={lang} requiredScope="tasks:write" className="max-w-xs" />
          ) : null}
        </>}
      />

      {apiMode && !canReadTasks && (
        <PermissionNotice lang={lang} requiredScope="tasks:read" mode="read" />
      )}

      {/* 队列 / Worker 心跳 / 回收站——这些是给排障用的技术细节。
          默认收进折叠块：运营人员打开这一页要管的是「写不写、写了多少」，
          而不是 worker id 与心跳时间（旧版这三块常驻顶部，把任务列表挤到三屏之外）。 */}
      {(onLoadHealth && onLoadRecentRuns) || (apiMode && canReadTasks && (onLoadWorkers || onLoadTrash)) ? (
        <details className="group rounded-2xl bg-slate-900/80">
          <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-3 text-xs font-semibold text-slate-300 [&::-webkit-details-marker]:hidden">
            <Wrench className="h-3.5 w-3.5 text-slate-400" />
            {lang === 'zh' ? '运行详情（排队情况、后台服务、回收站）' : 'Runtime details (queue, workers, trash)'}
            <ChevronDown className="ml-auto h-4 w-4 text-slate-500 transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-4 border-t border-slate-800 p-4">
            {onLoadHealth && onLoadRecentRuns && <TaskMonitoringPanel onLoadHealth={onLoadHealth} onLoadRecentRuns={onLoadRecentRuns} lang={lang} />}

      {apiMode && canReadTasks && onLoadWorkers && (
        <section className="rounded-2xl bg-slate-900/80 p-5" aria-labelledby="task-workers-heading">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-indigo-500/10 p-2 text-indigo-300">
                <Server className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <h2 id="task-workers-heading" className="text-section-title">
                  {lang === 'zh' ? '后台 Worker 状态' : 'Background workers'}
                </h2>
                <p className="mt-1 text-caption">
                  {workersUpdatedAt
                    ? (lang === 'zh' ? `最近检查 ${workersUpdatedAt}，每 30 秒自动刷新` : `Checked ${workersUpdatedAt}; refreshes every 30s`)
                    : (lang === 'zh' ? '状态来自 桐灼GEO worker 心跳记录' : 'Status comes from 桐灼GEO worker heartbeats')}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void refreshWorkers()}
              disabled={workersLoading}
              className="inline-flex h-9 items-center gap-1.5 self-start rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50 sm:self-auto"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${workersLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
              {lang === 'zh' ? '刷新状态' : 'Refresh'}
            </button>
          </div>
          {workersError && (
            <div role="alert" className="mt-3 flex flex-col gap-2 rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200 sm:flex-row sm:items-center sm:justify-between">
              <span>{workersError}</span>
              <button type="button" onClick={() => void refreshWorkers()} className="self-start rounded border border-rose-400/40 px-2 py-1 font-semibold hover:bg-rose-900/50 sm:self-auto">
                {lang === 'zh' ? '重试' : 'Retry'}
              </button>
            </div>
          )}
          {workersLoading && workers.length === 0 && !workersError && (
            <p className="mt-4 text-xs text-slate-400">{lang === 'zh' ? '正在读取 Worker 心跳…' : 'Reading worker heartbeats…'}</p>
          )}
          {!workersLoading && workers.length === 0 && !workersError && (
            <p className="mt-4 rounded-lg border border-dashed border-slate-700 px-3 py-4 text-center text-xs text-slate-500">
              {lang === 'zh' ? '当前没有可见的 Worker 心跳。启动队列 Worker 后这里会显示运行状态。' : 'No worker heartbeat is visible. Start a queue worker to see its status here.'}
            </p>
          )}
          {workers.length > 0 && (
            <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {workers.map((worker) => {
                const statusClass = worker.isStale
                  ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                  : worker.status === 'running'
                    ? 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30'
                    : worker.status === 'idle'
                      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                      : 'bg-slate-800 text-slate-300 border-slate-700';
                return (
                  <div key={worker.workerId} className="rounded-xl bg-slate-950/40 px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs text-slate-200" title={worker.workerId}>{worker.workerId}</span>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[12px] font-bold ${statusClass}`}>
                        {worker.statusLabel}
                      </span>
                    </div>
                    <p className="mt-2 text-[12.5px] text-slate-400">{worker.summary || (lang === 'zh' ? '暂无运行摘要' : 'No run summary')}</p>
                    {worker.taskName && <p className="mt-1 truncate text-[12.5px] text-slate-300">{lang === 'zh' ? '任务' : 'Task'}：{worker.taskName}</p>}
                    {worker.articleTitle && <p className="mt-1 truncate text-[12.5px] text-slate-500">{lang === 'zh' ? '文章' : 'Article'}：{worker.articleTitle}</p>}
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-slate-500">
                      {worker.memoryMb !== undefined && <span>{lang === 'zh' ? '内存' : 'Memory'} {worker.memoryMb.toFixed(1)} MB</span>}
                      <span>{worker.lastSeenHuman}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {apiMode && canReadTasks && onLoadTrash && (
        <section className="rounded-2xl bg-slate-900/80 p-5" aria-labelledby="task-trash-heading">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-slate-700/40 p-2 text-slate-300">
                <Trash2 className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <h2 id="task-trash-heading" className="text-section-title">
                  {lang === 'zh' ? '任务回收站' : 'Task trash'}
                  <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-[12px] font-semibold text-slate-400">{Number(trashPagination.total || trashedTasks.length)}</span>
                </h2>
                <p className="mt-1 text-caption">
                  {lang === 'zh' ? '删除的任务保留 90 天，可恢复但会以暂停状态返回。' : 'Deleted tasks are retained for 90 days and restore as paused.'}
                </p>
              </div>
            </div>
            <button type="button" onClick={() => setTrashOpen((open) => !open)} className="inline-flex h-9 items-center self-start rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800 sm:self-auto">
              {trashOpen ? (lang === 'zh' ? '收起' : 'Collapse') : (lang === 'zh' ? '查看回收站' : 'View trash')}
            </button>
          </div>
          {trashOpen && (
            <div className="mt-4 border-t border-slate-800 pt-4">
              {trashError && <div role="alert" className="mb-3 flex flex-col gap-2 rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200 sm:flex-row sm:items-center sm:justify-between"><span>{trashError}</span><button type="button" onClick={() => void refreshTrash()} className="self-start rounded border border-rose-400/40 px-2 py-1 font-semibold hover:bg-rose-900/50 sm:self-auto">{lang === 'zh' ? '重试' : 'Retry'}</button></div>}
              {trashLoading && trashedTasks.length === 0 && !trashError && <p className="text-xs text-slate-400">{lang === 'zh' ? '正在读取回收站…' : 'Loading task trash…'}</p>}
              {!trashLoading && trashedTasks.length === 0 && !trashError && <p className="rounded-lg border border-dashed border-slate-700 px-3 py-4 text-center text-xs text-slate-500">{lang === 'zh' ? '回收站为空' : 'Task trash is empty'}</p>}
              {trashedTasks.length > 0 && <div className="space-y-2">{trashedTasks.map((item) => {
                const id = String(item.id || '');
                const requiresSuperAdmin = Boolean(item.requires_super_admin_restore);
                const restoring = restoringTrashId === id;
                return <div key={`${id}-${String(item.trash_sequence || '')}`} className="flex flex-col gap-3 rounded-xl bg-slate-950/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0"><div className="truncate text-xs font-semibold text-slate-200">{String(item.name || `#${id}`)}</div><div className="mt-1 text-[12px] text-slate-500">{lang === 'zh' ? '删除于' : 'Deleted'} {String(item.deleted_at || '—')} · {lang === 'zh' ? '到期' : 'Expires'} {String(item.expires_at || '—')}</div></div>
                  {requiresSuperAdmin ? <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[12px] font-semibold text-amber-200">{lang === 'zh' ? '需超级管理员恢复' : 'Super admin required'}</span> : <button type="button" onClick={() => void handleRestoreTrash(item)} disabled={restoring || !onRestoreTask} className="inline-flex h-9 items-center justify-center gap-1.5 self-start rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 text-[12.5px] font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:opacity-50 sm:self-auto"><RefreshCw className={`h-3.5 w-3.5 ${restoring ? 'animate-spin' : ''}`} />{restoring ? (lang === 'zh' ? '恢复中…' : 'Restoring…') : (lang === 'zh' ? '恢复任务' : 'Restore')}</button>}
                </div>;
              })}</div>}
            </div>
          )}
        </section>
      )}

          </div>
        </details>
      ) : null}

      {/* 自动写作流水线（任务卡）：标题 + 一句说明，把「任务」这个词接到「写文章」这件事上 */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-section-title">{lang === 'zh' ? '自动写作流水线' : 'Automatic writing pipelines'}</h2>
          <p className="mt-1 text-caption">
            {lang === 'zh'
              ? '每条流水线就是一条任务：多久写一篇、用哪个模型、写到哪个分类。'
              : 'Each pipeline decides how often to write, with which model, into which category.'}
          </p>
        </div>
      </div>

      {/* Task Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading && tasks.length === 0 ? (
          /* 首轮数据未到：骨架卡，不画「还没有任务」 */
          [0, 1, 2].map((index) => (
            <div key={index} className="rounded-2xl bg-slate-900/80 p-5 space-y-4">
              <SkeletonRows rows={4} />
            </div>
          ))
        ) : tasks.length === 0 ? (
          <EmptyState
            className="md:col-span-2 lg:col-span-3"
            icon={Workflow}
            title={lang === 'zh' ? '还没有生成任务' : 'No generation tasks yet'}
            description={lang === 'zh'
              ? '生成任务负责「多久写一篇」。如果你只想马上要一篇文章，去「文章」页点「AI 生成文章」更快。'
              : 'Tasks automate recurring generation; for a one-off article use “Generate with AI” on the Articles page.'}
            action={canWriteTasks ? (
              <button
                onClick={openCreateModal}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                <Plus className="w-3.5 h-3.5" />
                {lang === 'zh' ? '新建生成任务' : 'New Task'}
              </button>
            ) : undefined}
          />
        ) : tasks.map((task) => {
          const jobStatus = String(task.batchStatus || task.latestJobStatus || '').toLowerCase();
          const jobBusy = ['pending', 'queued', 'running', 'processing'].includes(jobStatus);
          const taskLifecycleActive = task.rawStatus === 'active' || task.status === 'running';
          const taskActive = taskLifecycleActive && task.scheduleEnabled !== false;
          const isRunning = runningTaskId === task.id || jobBusy;
          const isActioning = actionTaskId === task.id;
          /**
           * 已达本次生成上限（`limit_reached`）：这条流水线已经产出到设定的篇数，
           * **再点「立即生成」也不会写**（后端不会再产）。按钮必须禁用并说明出路，
           * 否则就是一个「点了白跑」的假按钮（2026-09-14 哥哥指出的问题）。
           */
          const atGenerationLimit = jobStatus === 'limit_reached';
          const statusLabel = jobBusy
            ? (lang === 'zh' ? '作业运行中' : 'Job running')
              : taskLifecycleActive
              ? (lang === 'zh' ? '已启用' : 'Active')
              : task.status === 'completed'
                ? (lang === 'zh' ? '已完成' : 'Completed')
                : (lang === 'zh' ? '已暂停' : 'Paused');
          return (
            <div
              key={task.id}
              className="rounded-2xl bg-slate-900/80 p-5 flex flex-col justify-between space-y-4 transition hover:shadow-md"
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="text-[12px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-medium">
                      {task.targetCategory}
                    </span>
                    <h3 className="text-card-title mt-1.5 line-clamp-1">
                      {task.name}
                    </h3>
                  </div>
                  <span
                    className={`text-[12px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
                      jobBusy
                        ? 'bg-indigo-500/20 text-indigo-400 animate-pulse'
                        : taskActive
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {statusLabel}
                  </span>
                </div>

                <div className="space-y-1.5 text-[13px] text-slate-300 bg-slate-950/40 px-4 py-3 rounded-xl">
                  <div className="flex justify-between">
                    <span className="text-slate-400">{lang === 'zh' ? '使用模型' : 'Model'}:</span>
                    <span className="font-semibold text-white">{task.aiModel}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">{lang === 'zh' ? '生成频率' : 'Frequency'}:</span>
                    <span>{task.schedule}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">{lang === 'zh' ? '每次生成' : 'Per run'}:</span>
                    <span>{task.batchLimit} {lang === 'zh' ? '篇' : 'articles'}</span>
                  </div>
                  <div className="flex justify-between pt-1 border-t border-slate-800">
                    <span className="text-slate-400">{lang === 'zh' ? '累计生成' : 'Total output'}:</span>
                    <span className="font-bold text-emerald-400">{task.generatedCount}</span>
                  </div>
                  {apiMode && jobStatus && (
                    <div className="flex justify-between items-center text-[12.5px]">
                      <span className="text-slate-400">{lang === 'zh' ? '最近一次' : 'Latest job'}:</span>
                      {/* 原始枚举（completed / limit_reached / failed…）翻成中文语义 */}
                      <StatusBadge spec={jobStatusSpec(jobStatus)} lang={lang} className="!text-[12px]" />
                    </div>
                  )}
                  {atGenerationLimit && (
                    <div className="text-[12.5px] leading-relaxed text-amber-600">
                      {lang === 'zh'
                        ? `已达生成上限（每次 ${task.batchLimit} 篇，累计 ${task.generatedCount}）。要再写：点「编辑」把「每次生成」调大，或改成循环任务。`
                        : `Generation limit reached. Raise “per run” or switch to loop mode to keep writing.`}
                    </div>
                  )}
                  {apiMode && task.batchErrorMessage && (
                    <div role="status" className="text-[12.5px] text-rose-300 break-words">
                      {task.batchErrorMessage}
                    </div>
                  )}
                  {apiMode && taskActionErrors[task.id] && (
                    <div role="alert" className="text-[12.5px] text-amber-200 break-words">
                      {taskActionErrors[task.id]}
                    </div>
                  )}
                </div>
              </div>

              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between">
                <span className="text-[12.5px] text-slate-400">
                   {lang === 'zh' ? '上次运行' : 'Last run'}: {displayLastRun(task.lastRunAt)}
                </span>
                <div className="flex items-center gap-1.5 flex-wrap justify-end">
                  {/* 主操作：让这条任务现在就跑一次。
                      原来「单独入队」与「立即触发」是两个近义按钮（对用户而言都是「现在生成」），
                      已合并为一个；入队语义由后端在 startTask 内部处理。 */}
                  <button
                    onClick={() => void handleRun(task.id)}
                     disabled={isRunning || isActioning || atGenerationLimit || (apiMode && !canWriteTasks)}
                    title={atGenerationLimit
                      ? (lang === 'zh' ? '已达生成上限：先编辑把「每次生成」调大，或改成循环任务' : 'Generation limit reached — edit the task first')
                      : undefined}
                    className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50 transition hover:bg-indigo-500"
                  >
                  {isRunning ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>{jobBusy ? (lang === 'zh' ? '生成中…' : 'Running…') : (lang === 'zh' ? '启动中…' : 'Starting…')}</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5" />
                       <span>{apiMode && !canWriteTasks
                         ? (lang === 'zh' ? '只读' : 'Read-only')
                         : atGenerationLimit
                           ? (lang === 'zh' ? '已达上限' : 'Limit reached')
                           : (lang === 'zh' ? '立即生成' : 'Run Now')}</span>
                    </>
                  )}
                  </button>
                   {apiMode && canWriteTasks && taskLifecycleActive && onStopTask && (
                    <button
                      onClick={() => void handleStop(task.id)}
                      disabled={isActioning}
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-rose-950/60 hover:text-rose-200 hover:border-rose-800/70 disabled:opacity-50"
                    >
                      <Square className="w-3 h-3 fill-current" />
                      <span>{isActioning ? (lang === 'zh' ? '处理中' : 'Working') : (lang === 'zh' ? '停止' : 'Stop')}</span>
                    </button>
                  )}
                   {apiMode && canWriteTasks && onUpdateTask && (
                     <button
                       onClick={() => openEditModal(task)}
                       disabled={isActioning || deletingTaskId !== null}
                       className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50"
                       title={lang === 'zh' ? '编辑任务配置' : 'Edit task configuration'}
                     >
                       <Pencil className="w-3 h-3" />
                       <span>{lang === 'zh' ? '编辑' : 'Edit'}</span>
                     </button>
                   )}
                   {apiMode && canWriteTasks && onDeleteTask && (
                     <button
                       onClick={() => requestDelete(task.id)}
                       disabled={isActioning || deletingTaskId !== null}
                       className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-semibold text-slate-400 transition hover:bg-slate-800 hover:text-rose-300 disabled:opacity-50"
                       title={lang === 'zh' ? '删除任务（移入回收站）' : 'Delete task (move to trash)'}
                     >
                       <Trash2 className="w-3 h-3" />
                       <span>{lang === 'zh' ? '删除' : 'Delete'}</span>
                     </button>
                   )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

       {/* Create / edit task modal */}
       {isModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form
            onSubmit={handleSubmit}
            className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Workflow className="w-5 h-5 text-indigo-600" />
                 <span>{editingTask
                   ? (lang === 'zh' ? '编辑生成任务' : 'Edit Task')
                   : (lang === 'zh' ? '新建生成任务' : 'New Task')}</span>
               </h3>
               <button
                 type="button"
                 onClick={closeTaskModal}
                disabled={isSubmitting}
                className="text-slate-400 hover:text-slate-200 text-sm"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">
                  {lang === 'zh' ? '任务名称' : 'Task Name'} *
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"
                  placeholder="e.g. 每日 CRM 竞品评测自动生成"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">
                  {lang === 'zh' ? '目标分类' : 'Category'}
                </label>
                {apiMode ? (
                  <select
                    value={categoryId}
                    onChange={(e) => {
                      const next = e.target.value;
                      setCategoryId(next);
                      const category = apiCatalog?.categories.find((item) => String(item.id) === next);
                      if (category) setTargetCategory(category.name);
                    }}
                    className="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"
                  >
                    <option value="">{lang === 'zh' ? '智能分类（不固定）' : 'Smart category'}</option>
                    {(apiCatalog?.categories || []).map((category) => (
                      <option key={category.id} value={String(category.id)}>{category.name}</option>
                    ))}
                  </select>
                ) : (
                  <select
                    value={targetCategory}
                    onChange={(e) => setTargetCategory(e.target.value)}
                    className="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">
                  {lang === 'zh' ? 'AI 模型' : 'AI Model'}
                </label>
                {apiMode ? (
                    <select
                      value={aiModelId}
                      required={!editingTask}
                    onChange={(e) => {
                      setAiModelId(e.target.value);
                      const model = apiCatalog?.models.find((item) => String(item.id) === e.target.value);
                      if (model) setAiModel(model.name);
                    }}
                    className="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"
                  >
                    <option value="">{lang === 'zh' ? '请选择内容模型' : 'Select a content model'}</option>
                    {(apiCatalog?.models || []).filter((model) => !model.type || model.type === 'chat').map((model) => (
                      <option key={model.id} value={String(model.id)}>{model.name}</option>
                    ))}
                  </select>
                ) : (
                  <select
                    value={aiModel}
                    onChange={(e) => setAiModel(e.target.value)}
                    className="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"
                  >
                    <option value="Gemini 2.5 Flash">Google Gemini 2.5 Flash (推荐)</option>
                    <option value="Gemini 1.5 Pro">Google Gemini 1.5 Pro</option>
                    <option value="GPT-4o (OpenAI)">OpenAI GPT-4o</option>
                  </select>
                )}
              </div>

              {apiMode && (
                <>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-xs font-semibold text-slate-300">{lang === 'zh' ? '标题库' : 'Title library'} *</label>
                      {canReadTasks && onCheckTitleReadiness && (
                        <button
                          type="button"
                          onClick={() => void checkTitleReadiness()}
                          disabled={readinessLoading || !titleLibraryId}
                          className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 text-[12px] font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <ShieldCheck className={`h-3 w-3 ${readinessLoading ? 'animate-pulse' : ''}`} aria-hidden="true" />
                          {readinessLoading
                            ? (lang === 'zh' ? '检查中…' : 'Checking…')
                            : (lang === 'zh' ? '检查就绪度' : 'Check readiness')}
                        </button>
                      )}
                    </div>
                    <select required={!editingTask} value={titleLibraryId} onChange={(e) => setTitleLibraryId(e.target.value)} className="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500">
                      <option value="">{lang === 'zh' ? '请选择标题库' : 'Select a title library'}</option>
                      {(apiCatalog?.titleLibraries || []).map((item) => <option key={item.id} value={String(item.id)}>{item.name}</option>)}
                    </select>
                    {readinessError && (
                      <div role="alert" className="mt-2 rounded-lg border border-rose-500/30 bg-rose-950/30 px-2.5 py-2 text-[12.5px] text-rose-200">
                        {readinessError}
                      </div>
                    )}
                    {readiness && (
                      <div className={`mt-2 rounded-lg border px-2.5 py-2 text-[12.5px] ${
                        readiness.status === 'ready'
                          ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-200'
                          : readiness.status === 'warning'
                            ? 'border-amber-500/30 bg-amber-950/20 text-amber-200'
                            : 'border-rose-500/30 bg-rose-950/20 text-rose-200'
                      }`} role="status" aria-live="polite">
                        <div className="flex items-center justify-between gap-2 font-semibold">
                          <span>{readiness.status === 'ready'
                            ? (lang === 'zh' ? '标题库可用' : 'Title library ready')
                            : readiness.status === 'warning'
                              ? (lang === 'zh' ? '标题库可用，但有提醒' : 'Ready with warnings')
                              : (lang === 'zh' ? '标题库阻断启用' : 'Activation blocked')}</span>
                          <span>{readiness.library.available}/{readiness.library.total} {lang === 'zh' ? '可用标题' : 'available titles'}</span>
                        </div>
                        <p className="mt-1 opacity-90">
                          {lang === 'zh'
                            ? `本任务还需 ${readiness.task.remaining} 个标题${readiness.shortage > 0 ? `，缺口 ${readiness.shortage}` : ''}。`
                            : `${readiness.task.remaining} titles remain${readiness.shortage > 0 ? `; shortage ${readiness.shortage}` : ''}.`}
                        </p>
                        {readiness.issues.length > 0 && (
                          <ul className="mt-1 list-inside list-disc space-y-0.5 opacity-90">
                            {readiness.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{readinessIssueLabel(issue.code)}</li>)}
                          </ul>
                        )}
                        {readiness.conflictCount > 0 && (
                          <p className="mt-1 opacity-90">
                            {lang === 'zh' ? `另有 ${readiness.conflictCount} 个启用任务共用此标题库。` : `${readiness.conflictCount} active task(s) share this library.`}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-300">{lang === 'zh' ? '内容提示词' : 'Content prompt'} *</label>
                    <select required={!editingTask} value={promptId} onChange={(e) => setPromptId(e.target.value)} className="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500">
                      <option value="">{lang === 'zh' ? '请选择内容提示词' : 'Select a content prompt'}</option>
                      {(apiCatalog?.prompts || []).map((item) => <option key={item.id} value={String(item.id)}>{item.name}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-300">{lang === 'zh' ? '知识库（可选）' : 'Knowledge base (optional)'}</label>
                    <select value={knowledgeBaseId} onChange={(e) => setKnowledgeBaseId(e.target.value)} className="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500">
                      <option value="">{lang === 'zh' ? '不挂载知识库' : 'No knowledge base'}</option>
                      {(apiCatalog?.knowledgeBases || []).map((item) => <option key={item.id} value={String(item.id)}>{item.name}</option>)}
                    </select>
                  </div>
                </>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-300">
                    {lang === 'zh' ? '执行频次' : 'Schedule'}
                  </label>
                  <input
                    type={apiMode ? 'number' : 'text'}
                    min={apiMode ? 1 : undefined}
                    value={schedule}
                    onChange={(e) => setSchedule(e.target.value)}
                    className="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"
                    placeholder={apiMode ? (lang === 'zh' ? '间隔分钟数，例如 60' : 'Interval in minutes, e.g. 60') : undefined}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-300">
                    {lang === 'zh' ? '单次生成篇数' : 'Batch Count'}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={batchLimit}
                    onChange={(e) => setBatchLimit(Number(e.target.value))}
                    className="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"
                  />
                </div>
              </div>

              {apiMode && (
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={isLoop}
                    onChange={(e) => setIsLoop(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span>{lang === 'zh' ? '循环任务（允许标题复用）' : 'Loop task (allow title reuse)'}</span>
                </label>
              )}

              {apiMode && editingTask && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-300">
                      {lang === 'zh' ? '任务状态' : 'Task status'}
                    </label>
                    <select
                      value={taskStatus}
                      onChange={(e) => setTaskStatus(e.target.value === 'active' ? 'active' : 'paused')}
                      className="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"
                    >
                      <option value="paused">{lang === 'zh' ? '暂停' : 'Paused'}</option>
                      <option value="active">{lang === 'zh' ? '启用' : 'Active'}</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-300">
                      {lang === 'zh' ? '发布范围' : 'Publish scope'}
                    </label>
                    <select
                      value={publishScope}
                      onChange={(e) => setPublishScope(e.target.value)}
                      className="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"
                    >
                      <option value="local_only">{lang === 'zh' ? '仅本地' : 'Local only'}</option>
                      <option value="local_and_distribution">{lang === 'zh' ? '本地及分发' : 'Local and distribution'}</option>
                      <option value="distribution_only">{lang === 'zh' ? '仅分发' : 'Distribution only'}</option>
                    </select>
                  </div>
                  <label className="col-span-2 flex items-center gap-2 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={needReview}
                      onChange={(e) => setNeedReview(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span>{lang === 'zh' ? '生成文章需要人工审核' : 'Require human review for generated articles'}</span>
                  </label>
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-slate-800 flex justify-end gap-2">
              {formError && (
                <div role="alert" aria-live="polite" className="mr-auto max-w-[68%] rounded-lg border border-red-500/30 bg-red-950/40 px-3 py-1.5 text-xs text-red-200">
                  {formError}
                </div>
              )}
              <button
                type="button"
                onClick={closeTaskModal}
                disabled={isSubmitting}
                className="inline-flex h-9 items-center rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                {lang === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={!canWriteTasks || isSubmitting || (apiMode && !editingTask && (!titleLibraryId || !promptId || !aiModelId))}
                className="inline-flex h-9 items-center rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmitting
                  ? (editingTask
                    ? (lang === 'zh' ? '保存中...' : 'Saving...')
                    : (lang === 'zh' ? '创建中...' : 'Creating...'))
                  : (editingTask
                    ? (lang === 'zh' ? '保存修改' : 'Save changes')
                    : (lang === 'zh' ? '立即创建' : 'Create Task'))}
              </button>
            </div>
          </form>
        </div>
       )}

       {deletingTaskId && (
         <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
           <section
             role="alertdialog"
             aria-modal="true"
             aria-labelledby="delete-task-title"
             className="bg-slate-900 border border-rose-900/70 rounded-2xl max-w-sm w-full p-6 space-y-4 shadow-2xl"
           >
             <div className="flex items-start gap-3">
               <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" aria-hidden="true" />
               <div>
                 <h3 id="delete-task-title" className="text-base font-bold text-white">
                   {lang === 'zh' ? '确认删除任务？' : 'Delete this task?'}
                 </h3>
                 <p className="mt-1 text-xs leading-5 text-slate-300">
                   {lang === 'zh'
                     ? '任务会由后端移入回收站，相关运行记录不再出现在任务列表中。此操作需要管理员权限。'
                     : 'The backend will move this task to trash. It will disappear from the task list and requires administrator permission.'}
                 </p>
               </div>
             </div>
             {deleteError && (
               <div role="alert" aria-live="polite" className="rounded-lg border border-red-500/30 bg-red-950/40 px-3 py-2 text-xs text-red-200">
                 {deleteError}
               </div>
             )}
             <div className="flex justify-end gap-2">
               <button
                 type="button"
                 onClick={cancelDelete}
                 disabled={isSubmitting}
                 className="inline-flex h-9 items-center rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50"
               >
                 {lang === 'zh' ? '取消' : 'Cancel'}
               </button>
               <button
                 type="button"
                 onClick={() => void handleDeleteConfirmed()}
                 disabled={isSubmitting}
                 className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-rose-700 px-3.5 text-[13px] font-bold text-white transition hover:bg-rose-600 disabled:opacity-50"
               >
                 {isSubmitting && <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                 {isSubmitting
                   ? (lang === 'zh' ? '删除中...' : 'Deleting...')
                   : (lang === 'zh' ? '确认删除' : 'Delete')}
               </button>
             </div>
           </section>
         </div>
       )}
     </div>
    </>
  );
};
