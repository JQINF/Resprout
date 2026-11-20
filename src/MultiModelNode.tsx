import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import NodeCard from './NodeCard.tsx';
import { formatNodeTime, styleDimension } from './node-utils.ts';
import { buildQuickActionPreset, saveQuickActions } from './quick-actions.ts';
import type { QuickAction } from './quick-actions.ts';
import { DEFAULT_MULTI_INTERACTIVE_SIZE, DEFAULT_MULTI_MODEL_SIZE, multiModelGenerationKind } from './session.ts';
import type { ConversationNode, ModelSelection } from './session.ts';
import { useStore } from './store.ts';

const LEGACY_MULTI_MODEL_SIZES = [
  { width: 380, height: 320 },
  { width: 340, height: 250 },
  { width: 300, height: 220 },
];
const LEGACY_MULTI_INTERACTIVE_SIZES = [
  ...LEGACY_MULTI_MODEL_SIZES,
  { width: 300, height: 150 },
];

function modelKey(model: ModelSelection): string {
  return `${model.providerId}::${model.modelId}`;
}

export default function MultiModelNode({ id, data, selected }: NodeProps<ConversationNode>) {
  const providers = useStore(state => state.providers);
  const quickActions = useStore(state => state.quickActions);
  const setQuickActions = useStore(state => state.setQuickActions);
  const incomingQuote = useStore(state => state.edges.find(edge => edge.target === id)?.data.quote ?? '');
  const updateNodeContent = useStore(state => state.updateNodeContent);
  const applyNodePreset = useStore(state => state.applyNodePreset);
  const setNodeModels = useStore(state => state.setNodeModels);
  const generateMulti = useStore(state => state.generateMulti);
  const pickerRef = useRef<HTMLDetailsElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [actionsEditorOpen, setActionsEditorOpen] = useState(false);
  const [editingActionIndex, setEditingActionIndex] = useState(0);
  const selectedModels = data.models ?? (data.model ? [data.model] : []);
  const selectedKeys = new Set(selectedModels.map(modelKey));
  const hasContent = Boolean(data.content.trim());
  const kind = multiModelGenerationKind(data);
  const isInteractive = kind === 'interactive';
  const defaultSize = isInteractive ? DEFAULT_MULTI_INTERACTIVE_SIZE : DEFAULT_MULTI_MODEL_SIZE;
  const generationDisabled = data.pending || selectedModels.length === 0 || (!isInteractive && !hasContent);

  useLayoutEffect(() => {
    const node = useStore.getState().nodes.find(item => item.id === id);
    if (!node) return;
    const width = node.measured?.width ?? styleDimension(node.style?.width);
    const height = node.measured?.height ?? styleDimension(node.style?.height);
    if (width === undefined || height === undefined) return;
    const legacySizes = isInteractive ? LEGACY_MULTI_INTERACTIVE_SIZES : LEGACY_MULTI_MODEL_SIZES;
    if (!legacySizes.some(size =>
      Math.abs(width - size.width) <= 1 && Math.abs(height - size.height) <= 1)) return;
    useStore.getState().onNodesChange([{
      id,
      type: 'dimensions',
      resizing: false,
      setAttributes: true,
      dimensions: defaultSize,
    }]);
  }, [id, isInteractive, defaultSize]);

  useEffect(() => {
    if (!pickerOpen) return;
    const close = (event: Event) => {
      if (event instanceof PointerEvent && pickerRef.current?.contains(event.target as Node)) return;
      setPickerOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pickerOpen]);

  function applyPreset(action: QuickAction): void {
    const preset = buildQuickActionPreset(action, incomingQuote);
    applyNodePreset(id, preset.label, preset.prompt);
  }

  function updateQuickAction(index: number, patch: Partial<QuickAction>): void {
    setQuickActions(actions => actions.map((action, actionIndex) => actionIndex === index ? { ...action, ...patch } : action));
  }

  function removeQuickAction(index: number): void {
    setQuickActions(actions => actions.filter((_, actionIndex) => actionIndex !== index));
    setEditingActionIndex(0);
  }

  function addQuickAction(): void {
    setEditingActionIndex(quickActions.length);
    setQuickActions(actions => [...actions, { id: crypto.randomUUID(), label: '新按钮', prompt: '{text}' }]);
  }

  function closeActionsEditor(): void {
    saveQuickActions(quickActions);
    setActionsEditorOpen(false);
  }

  function toggleModel(model: ModelSelection): void {
    const key = modelKey(model);
    setNodeModels(id, selectedKeys.has(key)
      ? selectedModels.filter(item => modelKey(item) !== key)
      : [...selectedModels, model]);
  }

  return (
    <div className={`conversation-node question multi-model-node ${selected ? 'selected' : ''}`} data-generation-kind={kind}>
      <Handle type="target" position={Position.Left} />
      <div className="node-head">
        <div className="node-kind">{isInteractive ? '多模型交互' : '多模型回答'}</div>
        <span className="multi-model-count">{selectedModels.length} 个模型</span>
      </div>
      <NodeCard className="question multi-model-card">
        <details
          ref={pickerRef}
          className="multi-model-picker nodrag nowheel nopan"
          aria-label="选择多个模型"
          open={pickerOpen}
          onToggle={event => setPickerOpen(event.currentTarget.open)}
        >
          <summary><span>选择模型</span><span>{selectedModels.length ? `已选 ${selectedModels.length} 个` : '尚未选择'}</span></summary>
          <div className="multi-model-menu">
            {providers.map(provider => (
              <section className="multi-model-group" key={provider.id}>
                <strong>{provider.name}</strong>
                {provider.modelIds.map(modelId => {
                  const model = { providerId: provider.id, modelId };
                  const key = modelKey(model);
                  return (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={selectedKeys.has(key)}
                        disabled={data.pending}
                        onChange={() => toggleModel(model)}
                      />
                      <span>{modelId}</span>
                    </label>
                  );
                })}
              </section>
            ))}
            {!providers.length && <span className="multi-model-empty">请先在设置中配置模型</span>}
          </div>
        </details>
        {!isInteractive && (
        <div className="multi-model-preset-area">
            <div className="multi-model-presets nodrag nowheel nopan" role="group" aria-label="快捷预设与设置">
              {quickActions.map(action => (
                <button
                  key={action.id}
                  type="button"
                  className={data.content === action.label ? 'is-active' : ''}
                  disabled={data.pending}
                  onClick={() => applyPreset(action)}
                >{action.label}</button>
              ))}
              <button
                type="button"
                className={`quote-gear multi-model-preset-gear${actionsEditorOpen ? ' is-open' : ''}`}
                aria-label="编辑快捷预设"
                aria-expanded={actionsEditorOpen}
                onClick={() => actionsEditorOpen ? closeActionsEditor() : setActionsEditorOpen(true)}
              ><MultiSettingsIcon /></button>
            </div>
            {actionsEditorOpen && (
              <div className="surface quote-actions-editor multi-model-editor nodrag nowheel nopan">
                <div className="qae-title"><span>快捷预设</span><span>prompt 中 {'{text}'} 表示选中内容</span></div>
                <div className="qae-edit-tip">点击预设输入框，可修改标题并展开提示词</div>
                {quickActions.map((action, index) => (
                  <div className={`qae-row${editingActionIndex === index ? ' is-editing' : ''}`} key={action.id}>
                    <input
                      className="qae-label"
                      value={action.label}
                      aria-label="预设标题"
                      aria-expanded={editingActionIndex === index}
                      placeholder="预设标题"
                      title="点击修改标题和提示词"
                      onFocus={() => setEditingActionIndex(index)}
                      onChange={event => updateQuickAction(index, { label: event.target.value })}
                    />
                    {editingActionIndex === index && (
                      <textarea
                        className="qae-prompt"
                        value={action.prompt}
                        aria-label="自定义 prompt"
                        placeholder="自定义 prompt"
                        rows={3}
                        onChange={event => updateQuickAction(index, { prompt: event.target.value })}
                      />
                    )}
                    <button type="button" className="qae-delete" aria-label={`移除预设 ${action.label}`} onClick={() => removeQuickAction(index)}>移除</button>
                  </div>
                ))}
                <div className="qae-footer">
                  <button type="button" onClick={addQuickAction}>+ 添加按钮</button>
                  <button type="button" className="qae-save" onClick={closeActionsEditor}>完成</button>
                </div>
              </div>
            )}
        </div>
        )}
        {!isInteractive && (
        <textarea
          className="nodrag nowheel nopan"
          aria-label="多模型回答内容"
          placeholder="输入要比较的问题"
          value={data.content}
          readOnly={data.pending}
          onChange={event => updateNodeContent(id, event.target.value)}
          rows={5}
        />
        )}
        <div className="multi-model-actions nodrag nowheel nopan">
          <button type="button" className="primary" disabled={generationDisabled} onClick={() => void generateMulti(id)}>{isInteractive ? '生成交互' : '生成回答'}</button>
        </div>
        {data.pending && <span className="multi-model-status" role="status">正在使用 {selectedModels.length} 个模型并行生成{isInteractive ? '交互' : '回答'}…</span>}
        {data.error && <div className="node-error">{data.error}</div>}
      </NodeCard>
      <div className="node-footer">
        <span className="node-time">{formatNodeTime(data.createdAt)}</span>
        <span>每个模型生成一张{isInteractive ? '交互' : '回答'}卡片</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function MultiSettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
