import type { CSSProperties } from 'react';

export function styleDimension(value: CSSProperties['width']): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function formatNodeTime(value: number | string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (number: number): string => String(number).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
