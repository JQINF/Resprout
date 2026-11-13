import { readPdfFile } from './pdf-store.js';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGES_PER_TURN = 4;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
    image.src = url;
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });
}

async function compressedImage(blob) {
  if (!IMAGE_TYPES.has(blob.type)) throw new Error('只支持 PNG、JPEG、WebP 图片');
  const image = await decodeImage(blob);
  const sourceWidth = image.width;
  const sourceHeight = image.height;
  const scale = Math.min(1, 1600 / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const result = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!result) throw new Error('图片压缩失败');
  if (result.size > MAX_IMAGE_BYTES) throw new Error('压缩后的图片仍超过 2 MB，请使用更小的图片');
  if ('close' in image && typeof image.close === 'function') image.close();
  return result;
}

export async function prepareImageMessages(messages, modelInputs) {
  const imageCount = messages.filter(message => message.assetId).length;
  if (!imageCount) return messages;
  if (!modelInputs.includes('image')) throw new Error('当前模型未确认支持图片，图片内容未发送。请更换视觉模型。');
  if (imageCount > MAX_IMAGES_PER_TURN) throw new Error(`单轮最多附带 ${MAX_IMAGES_PER_TURN} 张图片`);
  const result = [];
  for (const message of messages) {
    if (!message.assetId) {
      result.push(message);
      continue;
    }
    const record = await readPdfFile(message.assetId);
    if (!record) throw new Error('没有找到图片原件，请重新拖入');
    const blob = await compressedImage(record.blob);
    const data = await blobToBase64(blob);
    result.push({
      ...message,
      content: [
        { type: 'text', text: String(message.content ?? '') },
        { type: 'image', data, mimeType: blob.type },
      ],
    });
  }
  return result;
}
