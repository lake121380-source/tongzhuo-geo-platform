import React, { useEffect, useRef, useState } from 'react';
import { Workflow, Plus, Play, CheckCircle2, Clock, Sparkles, RefreshCw, Square, ListPlus, Pencil, Trash2, AlertTriangle, Server, ShieldCheck } from 'lucide-react';
import { Task, Category, TaskTitleReadiness, TaskWorker } from '../types';
import { ApiRecord } from '../api/geoflowClient';
import { mapTaskTitleReadiness, mapTaskWorkers } from '../api/mappers';
import { hasScope } from '../api/permissions';
import PermissionNotice from './PermissionNotice';
import TaskMonitoringPanel from './TaskMonitoringPanel';

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
  lang: 'zh' | 'en';
  apiMode?: boolean;
  scopes?: readonly string[];
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
  lang,
  apiMode = false,
  scopes = [],
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
      {onLoadHealth && onLoadRecentRuns && <TaskMonitoringPanel onLoadHealth={onLoadHealth} onLoadRecentRuns={onLoadRecentRuns} lang={lang} />}
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-white flex items-center gap-2">
            <Workflow className="w-6 h-6 text-red-500" />
            {lang === 'zh' ? '自动化内容流水线与调度' : 'Task Automation & Pipelines'}
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            {lang === 'zh'
              ? '设定定时策略与大模型参数，自动化执行 RAG 召回、事实撰写及多渠道分发。'
              : 'Configure schedules and models to automate RAG synthesis, factual drafting, and distribution.'}
          </p>
        </div>

        {canWriteTasks ? (
          <button
            onClick={openCreateModal}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/20 transition self-start sm:self-auto"
          >
            <Plus className="w-4 h-4" />
            <span>{lang === 'zh' ? '新建流水线任务' : 'Create Pipeline'}</span>
          </button>
        ) : apiMode ? (
          <PermissionNotice lang={lang} requiredScope="tasks:write" className="max-w-xs" />
        ) : null}
      </div>

      {apiMode && !canReadTasks && (
        <PermissionNotice lang={lang} requiredScope="tasks:read" mode="read" />
      )}

      {apiMode && canReadTasks && onLoadWorkers && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 sm:p-5" aria-labelledby="task-workers-heading">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-blue-500/10 p-2 text-blue-300">
                <Server className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <h2 id="task-workers-heading" className="text-sm font-bold text-white">
                  {lang === 'zh' ? '后台 Worker 状态' : 'Background workers'}
                </h2>
                <p className="mt-1 text-[11px] text-slate-400">
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
              className="flex items-center gap-1.5 self-start rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700 disabled:opacity-50 sm:self-auto"
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
                    ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
                    : worker.status === 'idle'
                      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                      : 'bg-slate-800 text-slate-300 border-slate-700';
                return (
                  <div key={worker.workerId} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs text-slate-200" title={worker.workerId}>{worker.workerId}</span>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${statusClass}`}>
                        {worker.statusLabel}
                      </span>
                    </div>
                    <p className="mt-2 text-[11px] text-slate-400">{worker.summary || (lang === 'zh' ? '暂无运行摘要' : 'No run summary')}</p>
                    {worker.taskName && <p className="mt-1 truncate text-[11px] text-slate-300">{lang === 'zh' ? '任务' : 'Task'}：{worker.taskName}</p>}
                    {worker.articleTitle && <p className="mt-1 truncate text-[11px] text-slate-500">{lang === 'zh' ? '文章' : 'Article'}：{worker.articleTitle}</p>}
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
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
        <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 sm:p-5" aria-labelledby="task-trash-heading">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-slate-700/40 p-2 text-slate-300">
                <Trash2 className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <h2 id="task-trash-heading" className="text-sm font-bold text-white">
                  {lang === 'zh' ? '任务回收站' : 'Task trash'}
                  <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-400">{Number(trashPagination.total || trashedTasks.length)}</span>
                </h2>
                <p className="mt-1 text-[11px] text-slate-400">
                  {lang === 'zh' ? '删除的任务保留 90 天，可恢复但会以暂停状态返回。' : 'Deleted tasks are retained for 90 days and restore as paused.'}
                </p>
              </div>
            </div>
            <button type="button" onClick={() => setTrashOpen((open) => !open)} className="self-start rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700 sm:self-auto">
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
                return <div key={`${id}-${String(item.trash_sequence || '')}`} className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0"><div className="truncate text-xs font-semibold text-slate-200">{String(item.name || `#${id}`)}</div><div className="mt-1 text-[10px] text-slate-500">{lang === 'zh' ? '删除于' : 'Deleted'} {String(item.deleted_at || '—')} · {lang === 'zh' ? '到期' : 'Expires'} {String(item.expires_at || '—')}</div></div>
                  {requiresSuperAdmin ? <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-200">{lang === 'zh' ? '需超级管理员恢复' : 'Super admin required'}</span> : <button type="button" onClick={() => void handleRestoreTrash(item)} disabled={restoring || !onRestoreTask} className="inline-flex items-center justify-center gap-1.5 self-start rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:opacity-50 sm:self-auto"><RefreshCw className={`h-3.5 w-3.5 ${restoring ? 'animate-spin' : ''}`} />{restoring ? (lang === 'zh' ? '恢复中…' : 'Restoring…') : (lang === 'zh' ? '恢复任务' : 'Restore')}</button>}
                </div>;
              })}</div>}
            </div>
          )}
        </section>
      )}

      {/* Task Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {tasks.map((task) => {
          const jobStatus = String(task.batchStatus || task.latestJobStatus || '').toLowerCase();
          const jobBusy = ['pending', 'queued', 'running', 'processing'].includes(jobStatus);
          const taskLifecycleActive = task.rawStatus === 'active' || task.status === 'running';
          const taskActive = taskLifecycleActive && task.scheduleEnabled !== false;
          const isRunning = runningTaskId === task.id || jobBusy;
          const isActioning = actionTaskId === task.id;
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
              className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between space-y-4 hover:border-slate-700 transition"
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-medium">
                      {task.targetCategory}
                    </span>
                    <h3 className="text-base font-bold text-slate-100 mt-1.5 line-clamp-1">
                      {task.name}
                    </h3>
                  </div>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
                      jobBusy
                        ? 'bg-blue-500/20 text-blue-400 animate-pulse'
                        : taskActive
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {statusLabel}
                  </span>
                </div>

                <div className="space-y-1.5 text-xs text-slate-300 bg-slate-950/40 p-3 rounded-xl border border-slate-800/80">
                  <div className="flex justify-between">
                    <span className="text-slate-400">{lang === 'zh' ? '执行模型' : 'AI Model'}:</span>
                    <span className="font-semibold text-white">{task.aiModel}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">{lang === 'zh' ? '执行策略' : 'Schedule'}:</span>
                    <span>{task.schedule}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">{lang === 'zh' ? '单次限额' : 'Batch Size'}:</span>
                    <span>{task.batchLimit} {lang === 'zh' ? '篇' : 'articles'}</span>
                  </div>
                  <div className="flex justify-between pt-1 border-t border-slate-800">
                    <span className="text-slate-400">{lang === 'zh' ? '累计产出' : 'Total Output'}:</span>
                    <span className="font-bold text-emerald-400">{task.generatedCount}</span>
                  </div>
                  {apiMode && jobStatus && (
                    <div className="flex justify-between text-[11px]">
                      <span className="text-slate-400">{lang === 'zh' ? '最近作业' : 'Latest job'}:</span>
                      <span className={jobBusy ? 'text-blue-300' : jobStatus === 'failed' ? 'text-rose-300' : 'text-slate-300'}>
                        {jobStatus}
                      </span>
                    </div>
                  )}
                  {apiMode && task.batchErrorMessage && (
                    <div role="status" className="text-[11px] text-rose-300 break-words">
                      {task.batchErrorMessage}
                    </div>
                  )}
                  {apiMode && taskActionErrors[task.id] && (
                    <div role="alert" className="text-[11px] text-amber-200 break-words">
                      {taskActionErrors[task.id]}
                    </div>
                  )}
                </div>
              </div>

              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between">
                <span className="text-[11px] text-slate-400">
                   {lang === 'zh' ? '上次运行' : 'Last run'}: {displayLastRun(task.lastRunAt)}
                </span>
                <div className="flex items-center gap-1.5 flex-wrap justify-end">
                   {apiMode && canWriteTasks && onUpdateTask && (
                     <button
                       onClick={() => openEditModal(task)}
                       disabled={isActioning || deletingTaskId !== null}
                       className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-50 transition border border-slate-700"
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
                       className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold bg-rose-950/60 hover:bg-rose-900/70 text-rose-200 disabled:opacity-50 transition border border-rose-800/70"
                       title={lang === 'zh' ? '删除任务（移入回收站）' : 'Delete task (move to trash)'}
                     >
                       <Trash2 className="w-3 h-3" />
                       <span>{lang === 'zh' ? '删除' : 'Delete'}</span>
                     </button>
                   )}
                   {apiMode && canWriteTasks && taskLifecycleActive && onStopTask && (
                    <button
                      onClick={() => void handleStop(task.id)}
                      disabled={isActioning}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold bg-rose-950/60 hover:bg-rose-900/70 text-rose-200 disabled:opacity-50 transition border border-rose-800/70"
                    >
                      <Square className="w-3 h-3 fill-current" />
                      <span>{isActioning ? (lang === 'zh' ? '处理中' : 'Working') : (lang === 'zh' ? '停止' : 'Stop')}</span>
                    </button>
                  )}
                   {apiMode && canWriteTasks && taskActive && onEnqueueTask && !jobBusy && (
                    <button
                      onClick={() => void handleEnqueue(task.id)}
                      disabled={isActioning}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold bg-amber-950/60 hover:bg-amber-900/70 text-amber-200 disabled:opacity-50 transition border border-amber-800/70"
                    >
                      <ListPlus className="w-3.5 h-3.5" />
                      <span>{lang === 'zh' ? '单独入队' : 'Enqueue'}</span>
                    </button>
                  )}
                  <button
                    onClick={() => void handleRun(task.id)}
                     disabled={isRunning || isActioning || (apiMode && !canWriteTasks)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-white disabled:opacity-50 transition border border-slate-700"
                  >
                  {isRunning ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-400" />
                      <span>{jobBusy ? (lang === 'zh' ? '作业中...' : 'Job running...') : (lang === 'zh' ? '启动中...' : 'Starting...')}</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5 text-emerald-400 fill-emerald-400" />
                       <span>{apiMode && !canWriteTasks
                         ? (lang === 'zh' ? '只读' : 'Read-only')
                         : (lang === 'zh' ? '立即触发' : 'Run Now')}</span>
                    </>
                  )}
                  </button>
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
                <Workflow className="w-5 h-5 text-red-500" />
                 <span>{editingTask
                   ? (lang === 'zh' ? '编辑自动化流水线' : 'Edit Pipeline Task')
                   : (lang === 'zh' ? '新建自动化流水线' : 'Create Pipeline Task')}</span>
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
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition"
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
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition"
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
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition"
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
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition"
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
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition"
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
                          className="flex items-center gap-1 rounded-md border border-blue-500/40 px-2 py-1 text-[10px] font-semibold text-blue-200 transition hover:bg-blue-900/30 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <ShieldCheck className={`h-3 w-3 ${readinessLoading ? 'animate-pulse' : ''}`} aria-hidden="true" />
                          {readinessLoading
                            ? (lang === 'zh' ? '检查中…' : 'Checking…')
                            : (lang === 'zh' ? '检查就绪度' : 'Check readiness')}
                        </button>
                      )}
                    </div>
                    <select required={!editingTask} value={titleLibraryId} onChange={(e) => setTitleLibraryId(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition">
                      <option value="">{lang === 'zh' ? '请选择标题库' : 'Select a title library'}</option>
                      {(apiCatalog?.titleLibraries || []).map((item) => <option key={item.id} value={String(item.id)}>{item.name}</option>)}
                    </select>
                    {readinessError && (
                      <div role="alert" className="mt-2 rounded-lg border border-rose-500/30 bg-rose-950/30 px-2.5 py-2 text-[11px] text-rose-200">
                        {readinessError}
                      </div>
                    )}
                    {readiness && (
                      <div className={`mt-2 rounded-lg border px-2.5 py-2 text-[11px] ${
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
                    <select required={!editingTask} value={promptId} onChange={(e) => setPromptId(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition">
                      <option value="">{lang === 'zh' ? '请选择内容提示词' : 'Select a content prompt'}</option>
                      {(apiCatalog?.prompts || []).map((item) => <option key={item.id} value={String(item.id)}>{item.name}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-slate-300">{lang === 'zh' ? '知识库（可选）' : 'Knowledge base (optional)'}</label>
                    <select value={knowledgeBaseId} onChange={(e) => setKnowledgeBaseId(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition">
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
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition"
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
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition"
                  />
                </div>
              </div>

              {apiMode && (
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={isLoop}
                    onChange={(e) => setIsLoop(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-700 bg-slate-800 text-red-600 focus:ring-red-500"
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
                      className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition"
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
                      className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition"
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
                      className="h-4 w-4 rounded border-slate-700 bg-slate-800 text-red-600 focus:ring-red-500"
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
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                {lang === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={!canWriteTasks || isSubmitting || (apiMode && !editingTask && (!titleLibraryId || !promptId || !aiModelId))}
                className="px-4 py-1.5 rounded-lg text-xs font-bold bg-red-600 hover:bg-red-500 text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
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
                 className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-50"
               >
                 {lang === 'zh' ? '取消' : 'Cancel'}
               </button>
               <button
                 type="button"
                 onClick={() => void handleDeleteConfirmed()}
                 disabled={isSubmitting}
                 className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold bg-rose-700 hover:bg-rose-600 text-white disabled:opacity-50"
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
