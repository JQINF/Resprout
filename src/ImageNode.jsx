import { useEffect, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import NodeCard from './NodeCard.jsx';
import { readPdfFile } from './pdf-store.js';
import { useStore } from './store.js';
import './ImageNode.css';

export default function ImageNode({ id, data, selected }) {
  const askFromSelection = useStore(state => state.askFromSelection);
  const activeProvider = useStore(state => state.activeProvider);
  const providers = useStore(state => state.providers);
  const [imageUrl, setImageUrl] = useState('');
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const selectedModel = data.model ?? activeProvider;
  const modelInputs = providers.find(provider => provider.id === selectedModel?.providerId)?.modelInputs?.[selectedModel?.modelId] ?? ['text'];
  const supportsImages = modelInputs.includes('image');

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    readPdfFile(data.fileId).then(record => {
      if (!record) {
        if (active) setError('没有找到图片原件，请重新拖入');
        return;
      }
      objectUrl = URL.createObjectURL(record.blob);
      if (active) setImageUrl(objectUrl);
      else URL.revokeObjectURL(objectUrl);
    }).catch(cause => {
      if (active) setError(cause.message);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [data.fileId]);

  function ask() {
    const task = question.trim() || '请解释这张图片';
    const prompt = `用户附带了一张图片《${data.fileName}》。用户要求：${task}\n请直接基于图片内容回答，不要要求用户重新提供图片。若要求是翻译且未指定目标语言，请将图片中的外文翻译为中文。`;
    askFromSelection({
      sourceId: id,
      quote: `【图片：${data.fileName}】${task}`,
      highlightQuote: '图片内容',
      textStart: null,
      anchor: { x: 220, y: 220 },
      question: task,
      prompt,
      imageAssetId: data.fileId,
    });
    setQuestion('');
  }

  return (
    <div className={`conversation-node assistant image-node ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-kind">图片</div>
      <NodeCard className="assistant image-card">
        <header className="image-header">
          <span className="image-file-mark">IMG</span>
          <strong title={data.fileName}>{data.fileName}</strong>
        </header>
        <div className="image-preview nodrag nowheel">
          {imageUrl ? <img src={imageUrl} alt={data.fileName} /> : <div className="image-status">{error || '正在读取图片…'}</div>}
        </div>
        <div className="image-question nodrag">
          <input
            aria-label="围绕图片提问"
            value={question}
            placeholder="围绕这张图片提问，Enter 发送"
            onChange={event => setQuestion(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              event.preventDefault();
              ask();
            }}
          />
          <button type="button" onClick={ask}>提问</button>
        </div>
        <footer className={supportsImages ? 'image-capability' : 'image-capability warning'}>
          {supportsImages ? '当前模型支持图片输入' : '当前模型未确认视觉能力'}
        </footer>
      </NodeCard>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
