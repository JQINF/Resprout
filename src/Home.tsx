import { useEffect, useState } from 'react';
import { deleteSessionRecord, listSessionRecords } from './session-library.ts';
import type { SessionSummary } from './session-library.ts';
import { discardSessionCache, useStore } from './store.ts';
import resproutLogo from '../assets/brand/resprout-wordmark-light.png';

interface SessionHomeProps {
  onNew: () => void;
  onOpen: (id: string) => void | Promise<void>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatUpdatedAt(value: string): string {
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

export default function SessionHome({ onNew, onOpen }: SessionHomeProps) {
  const [records, setRecords] = useState<SessionSummary[]>([]);
  const [error, setError] = useState('');
  const generationRuns = useStore(state => state.generationRuns);

  useEffect(() => { void refresh(); }, [generationRuns]);

  async function refresh(): Promise<void> {
    try {
      setRecords(await listSessionRecords());
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function open(id: string) {
    setError('');
    try {
      await onOpen(id);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function remove(id: string, title: string) {
    if (!window.confirm(`确定删除会话“${title}”？此操作不可撤销。`)) return;
    discardSessionCache(id);
    await deleteSessionRecord(id);
    await refresh();
  }

  return (
    <div className="session-home">
      <main className="home-main">
        <section className="history-section">
          <div className="home-actions">
            <img className="home-logo" src={resproutLogo} alt="Resprout" />
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
              {records.map(record => {
                const runs = Object.values(generationRuns).filter(run => run.sessionId === record.id);
                const answers = runs.filter(run => run.kind === 'answer').length;
                const interactive = runs.filter(run => run.kind === 'interactive').length;
                const status = [
                  answers ? `回答中${answers > 1 ? `（${answers}）` : ''}` : '',
                  interactive ? `交互生成中${interactive > 1 ? `（${interactive}）` : ''}` : '',
                ].filter(Boolean).join(' · ');
                return (
                  <article className={`history-card${status ? ' is-running' : ''}`} key={record.id}>
                    <button type="button" className="session-open" onClick={() => open(record.id)}>
                      <strong>{record.title}</strong>
                      {status && <span className="session-running"><span className="session-running-dot" aria-hidden="true" />{status}</span>}
                      {record.preview && <span className="session-preview">{record.preview}</span>}
                      <span className="session-meta">{formatUpdatedAt(record.updatedAt)} · {record.nodeCount} 个节点</span>
                    </button>
                    <button type="button" className="session-delete" aria-label={`删除会话 ${record.title}`} onClick={() => remove(record.id, record.title)}>删除</button>
                  </article>
                );
              })}
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
