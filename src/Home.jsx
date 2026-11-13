import { useState } from 'react';
import { deleteSessionRecord, listSessionRecords } from './session-library.js';

function formatUpdatedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export default function SessionHome({ onNew, onOpen }) {
  const [records, setRecords] = useState(listSessionRecords);
  const [error, setError] = useState('');

  function open(id) {
    setError('');
    try {
      onOpen(id);
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function remove(id, title) {
    if (!window.confirm(`确定删除会话“${title}”？此操作不可撤销。`)) return;
    await deleteSessionRecord(id);
    setRecords(listSessionRecords());
  }

  return (
    <div className="session-home">
      <main className="home-main">
        <section className="history-section">
          <div className="home-actions">
            <button type="button" className="new-session-button" onClick={onNew}>新建会话</button>
          </div>
          <div className="history-heading">
            <div className="history-title">
              <h2>历史会话</h2>
              <span>{records.length} 个会话</span>
            </div>
          </div>
          {error && <div className="settings-error">{error}</div>}
          {records.length ? (
            <div className="history-grid">
              {records.map(record => (
                <article className="history-card" key={record.id}>
                  <button type="button" className="session-open" onClick={() => open(record.id)}>
                    <strong>{record.title}</strong>
                    {record.preview && <span className="session-preview">{record.preview}</span>}
                    <span className="session-meta">{formatUpdatedAt(record.updatedAt)} · {record.nodeCount} 个节点</span>
                  </button>
                  <button type="button" className="session-delete" aria-label={`删除会话 ${record.title}`} onClick={() => remove(record.id, record.title)}>删除</button>
                </article>
              ))}
            </div>
          ) : (
            <div className="history-empty">
              <strong>还没有历史会话</strong>
              <span>新建会话后，内容会自动保存在这里。</span>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
