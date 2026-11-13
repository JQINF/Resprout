import { useEffect, useRef, useState } from 'react';
import { kimiCodeCredentialIssue } from '../sidecar/provider-compatibility.mjs';
import { discoverProviderModels } from './api.js';
import { useStore } from './store.js';

const presets = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    name: 'DeepSeek',
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    modelIds: ['deepseek-flash', 'deepseek-v4-pro'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    modelIds: [],
  },
  {
    id: 'kimi-code',
    label: 'Kimi Code',
    name: 'Kimi Code',
    kind: 'openai',
    baseUrl: 'https://api.kimi.com/coding/v1',
    modelIds: ['kimi-for-coding'],
  },
  {
    id: 'moonshot',
    label: 'Moonshot 开放平台',
    name: 'Moonshot 开放平台',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    modelIds: [],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    name: '智谱 GLM',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelIds: [],
  },
  {
    id: 'qwen',
    label: '通义千问',
    name: '通义千问',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelIds: [],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    name: 'MiniMax',
    kind: 'openai',
    baseUrl: 'https://api.minimax.io/v1',
    modelIds: [],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    name: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelIds: [],
  },
  {
    id: 'xai',
    label: 'xAI',
    name: 'xAI',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    modelIds: [],
  },
  {
    id: 'groq',
    label: 'Groq',
    name: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    modelIds: [],
  },
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容',
    name: '自定义供应商',
    kind: 'openai',
    baseUrl: '',
    modelIds: [],
  },
];

function modelIdsFromText(value) {
  return [...new Set(String(value).split(/[,\n]/).map(id => id.trim()).filter(Boolean))];
}

function ProviderForm({ provider, onBack }) {
  const saveProvider = useStore(state => state.saveProvider);
  const deleteProvider = useStore(state => state.deleteProvider);
  const [form, setForm] = useState(() => provider ? {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    apiKey: '',
  } : { ...presets[0], id: undefined, apiKey: '' });
  const [modelText, setModelText] = useState(() => (provider?.modelIds ?? presets[0].modelIds).join(', '));
  const [modelContexts, setModelContexts] = useState(() => ({ ...(provider?.modelContexts ?? {}) }));
  const [modelInputs, setModelInputs] = useState(() => ({ ...(provider?.modelInputs ?? {}) }));
  const modelIds = modelIdsFromText(modelText);
  const [availableModels, setAvailableModels] = useState([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryNotice, setDiscoveryNotice] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const keyInputRef = useRef(null);
  const hasStoredKey = Boolean(provider?.hasApiKey && !form.apiKey);
  const kimiCredentialIssue = kimiCodeCredentialIssue(form);
  const kimiCodePreset = presets.find(preset => preset.id === 'kimi-code');

  function update(field, value) {
    setForm(current => ({ ...current, [field]: value }));
    if (field === 'baseUrl' || field === 'apiKey') {
      setAvailableModels([]);
      if (field === 'baseUrl') setModelContexts({});
      if (field === 'baseUrl') setModelInputs({});
      setDiscoveryNotice('');
    }
  }

  function choosePreset(preset) {
    setForm(current => ({
      ...current,
      name: preset.name,
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      apiKey: current.apiKey,
    }));
    setModelText(preset.modelIds.join(', '));
    setModelContexts({});
    setModelInputs({});
    setAvailableModels([]);
    setDiscoveryNotice('');
    setError('');
  }

  function toggleModel(id) {
    const next = modelIds.includes(id) ? modelIds.filter(modelId => modelId !== id) : [...modelIds, id];
    setModelText(next.join(', '));
  }

  async function discover() {
    setDiscovering(true);
    setError('');
    setDiscoveryNotice('');
    try {
      const result = await discoverProviderModels({
        providerId: form.id,
        kind: form.kind,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
      });
      setAvailableModels(result.models);
      setModelContexts(result.contexts ?? {});
      setModelInputs(result.inputs ?? {});
      if (!result.models.length) {
        setDiscoveryNotice(`API 已响应，但没有返回当前支持的对话模型。${result.notice ? ` ${result.notice}。` : ' 可继续手动输入模型 ID。'}`);
        return;
      }
      const retained = modelIds.filter(id => result.models.includes(id));
      setModelText((retained.length ? retained : result.models.slice(0, 1)).join(', '));
      const contextCount = Object.keys(result.contexts ?? {}).length;
      setDiscoveryNotice(`已获取 ${result.models.length} 个可用模型，请选择需要使用的模型。${contextCount ? ` 已读取 ${contextCount} 个模型的上下文窗口。` : ''}${result.notice ? ` ${result.notice}。` : ''}`);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setDiscovering(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (!modelIds.length) {
      setError('请至少选择或输入一个模型 ID');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await saveProvider({
        id: form.id,
        name: form.name,
        kind: form.kind,
        baseUrl: form.baseUrl,
        modelIds,
        modelContexts,
        modelInputs,
        apiKey: form.apiKey,
        activate: true,
      });
      onBack();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm(`确定删除供应商“${provider.name}”？`)) return;
    try {
      await deleteProvider(provider.id);
      onBack();
    } catch (cause) {
      setError(cause.message);
    }
  }

  return (
    <form className="provider-form" onSubmit={submit}>
      <div className="settings-titlebar">
        <button type="button" className="icon-button" aria-label="返回供应商列表" onClick={onBack}>←</button>
        <h2>{provider ? '编辑供应商' : '添加供应商'}</h2>
      </div>
      <div className="preset-list">
        {presets.map(preset => (
          <button
            type="button"
            key={preset.id}
            className={form.name === preset.name && form.kind === preset.kind ? 'preset active' : 'preset'}
            onClick={() => choosePreset(preset)}
          >{preset.label}</button>
        ))}
      </div>
      <label>名称<input required value={form.name} onChange={event => update('name', event.target.value)} /></label>
      <label>API 协议<input value="OpenAI Completions" readOnly /></label>
      <label>
        API Key
        <span className="key-input">
          <input
            ref={keyInputRef}
            type={showKey ? 'text' : 'password'}
            required={!provider}
            placeholder={hasStoredKey ? '••••••••••••••••••••' : provider ? '留空则保留现有 Key' : 'sk-...'}
            value={form.apiKey}
            onChange={event => update('apiKey', event.target.value)}
            autoComplete="off"
          />
          <button
            type="button"
            className="icon-button"
            aria-label={hasStoredKey ? '更换 API Key' : showKey ? '隐藏 API Key' : '显示 API Key'}
            onClick={() => hasStoredKey ? keyInputRef.current?.focus() : setShowKey(value => !value)}
          >{hasStoredKey ? '更换' : showKey ? '隐藏' : '显示'}</button>
        </span>
        {provider?.hasApiKey && <small className="key-status">已保存 Key，原值不会回传页面；留空保存会继续使用。</small>}
      </label>
      <label>Base URL<input required type="url" value={form.baseUrl} onChange={event => update('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" /></label>
      {kimiCredentialIssue && (
        <div className="provider-compatibility-warning" role="alert">
          <span>{kimiCredentialIssue.message}</span>
          <button type="button" onClick={() => choosePreset({ ...kimiCodePreset, baseUrl: kimiCredentialIssue.baseUrl })}>改用 Kimi Code 配置</button>
        </div>
      )}
      <div className="model-discovery">
        <div className="model-discovery-heading">
          <div><strong>可用模型</strong><small>检查 API 后，选择要使用的模型</small></div>
          <button
            type="button"
            className="discover-models-button"
            disabled={discovering || !form.baseUrl.trim() || (!provider && !form.apiKey.trim())}
            onClick={discover}
          >{discovering ? '正在检查…' : '检查并获取模型'}</button>
        </div>
        {availableModels.length > 0 && (
          <>
            <div className="model-selection-toolbar">
              <span>已选 {modelIds.length} / {availableModels.length}</span>
              <div>
                <button type="button" onClick={() => setModelText(availableModels.join(', '))}>全选</button>
                <button type="button" onClick={() => setModelText('')}>清空</button>
              </div>
            </div>
            <div className="model-options" role="group" aria-label="API 返回的可用模型">
              {availableModels.map(id => (
                <label className={modelIds.includes(id) ? 'model-option selected' : 'model-option'} key={id}>
                  <input type="checkbox" checked={modelIds.includes(id)} onChange={() => toggleModel(id)} />
                  <span>{id}</span>
                </label>
              ))}
            </div>
          </>
        )}
        {discoveryNotice && <p className="field-help">{discoveryNotice}</p>}
      </div>
      <label className="model-id-field">
        <span className="field-label-row">模型 ID<small>已选 {modelIds.length} 个，可手动编辑</small></span>
        <textarea
          required
          rows={availableModels.length ? 2 : 3}
          value={modelText}
          onChange={event => setModelText(event.target.value)}
          placeholder="多个模型使用逗号或换行分隔"
        />
      </label>
      <p className="field-help">保存后会自动切换到该供应商的第一个模型，之后可在列表顶部切换。</p>
      {error && <div className="settings-error">{error}</div>}
      <div className="settings-actions">
        {provider && !provider.environment && <button type="button" className="danger-button" onClick={remove}>删除</button>}
        <span />
        <button type="button" onClick={onBack}>取消</button>
        <button type="submit" className="primary-button" disabled={saving}>{saving ? '保存中…' : '保存并使用'}</button>
      </div>
    </form>
  );
}

export default function ProviderSettings({ onClose }) {
  const providers = useStore(state => state.providers);
  const active = useStore(state => state.activeProvider);
  const loadProviders = useStore(state => state.loadProviders);
  const activateProvider = useStore(state => state.activateProvider);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    loadProviders().catch(cause => setError(cause.message));
    const closeOnEscape = event => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [loadProviders]);

  async function changeActive(value) {
    const separator = value.indexOf('::');
    if (separator < 0) return;
    try {
      await activateProvider({ providerId: value.slice(0, separator), modelId: value.slice(separator + 2) });
    } catch (cause) {
      setError(cause.message);
    }
  }

  const editingProvider = providers.find(provider => provider.id === editing);
  return (
    <div className="settings-overlay" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="settings-panel glass-surface" role="dialog" aria-modal="true" aria-label="模型供应商设置">
        {editing === 'new' || editingProvider ? (
          <ProviderForm provider={editingProvider} onBack={() => setEditing(null)} />
        ) : (
          <>
            <div className="settings-titlebar">
              <h2>模型供应商</h2>
              <button className="icon-button" aria-label="关闭模型设置" onClick={onClose}>×</button>
            </div>
            <label className="active-model-select">
              当前模型
              <select value={active ? `${active.providerId}::${active.modelId}` : ''} onChange={event => changeActive(event.target.value)} disabled={!providers.length}>
                {!active && <option value="">未配置</option>}
                {providers.flatMap(provider => provider.modelIds.map(modelId => (
                  <option key={`${provider.id}::${modelId}`} value={`${provider.id}::${modelId}`}>{provider.name} / {modelId}</option>
                )))}
              </select>
            </label>
            <div className="provider-list-heading">
              <span>已配置供应商</span>
              <button className="primary-button" onClick={() => setEditing('new')}>＋ 添加供应商</button>
            </div>
            <div className="provider-list">
              {providers.map(provider => (
                <div className="provider-row" key={provider.id}>
                  <button className="provider-summary" disabled={provider.environment} onClick={() => setEditing(provider.id)}>
                    <span className="provider-logo">{provider.name.slice(0, 1).toUpperCase()}</span>
                    <span className="provider-info"><strong>{provider.name}</strong><small>{provider.baseUrl}</small></span>
                    <span className="protocol-badge">{provider.kind === 'deepseek' ? 'deepseek' : 'openai'}</span>
                    {active?.providerId === provider.id && <span className="using-badge">使用中</span>}
                    <span className="model-count">{provider.modelIds.length} 个模型</span>
                  </button>
                </div>
              ))}
              {!providers.length && <div className="providers-empty">尚未配置供应商，请点击“添加供应商”。</div>}
            </div>
            <p className="settings-note">API Key 仅由本机 sidecar 保存，不会回传到页面或随 Session 导出。</p>
          </>
        )}
        {error && <div className="settings-error">{error}</div>}
      </section>
    </div>
  );
}
