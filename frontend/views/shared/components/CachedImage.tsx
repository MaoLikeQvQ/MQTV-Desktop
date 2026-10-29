import { useEffect, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import { loadCachedImage } from '@/services/images';

/** 使用共享图片缓存加载封面，管理 object URL 生命周期并在失败时展示回退内容。 */
export function CachedImage({ src, fallback, ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { src: string; fallback: ReactNode }) {
  const [image, setImage] = useState({ source: '', url: '', failed: false });
  useEffect(() => {
    let active = true, objectUrl = '';
    setImage({ source: src, url: '', failed: false });
    loadCachedImage(src).then(blob => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setImage({ source: src, url: objectUrl, failed: false });
    }).catch(() => { if (active) setImage({ source: src, url: '', failed: true }); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src]);
  if (image.source !== src || !image.url || image.failed) return <>{fallback}</>;
  return <img {...props} src={image.url} onError={() => setImage(previous => ({ ...previous, failed: true }))} />;
}
