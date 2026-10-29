import { episodeLabel } from '@/domain/media/episode-label';
import { Button } from '@mui/material';

/** 左上角徽标显示选集序号，正文省略重复序号和扩展名，悬浮及辅助阅读保留完整文件名。 */
export function EpisodeButton({name,number,active,disabled,onClick}: {name:string;number:number;active:boolean;disabled:boolean;onClick:()=>void}) {
  const { badge, label } = episodeLabel(name, number);
  return <Button size="small" className="episode-tile" title={name} aria-label={`第 ${number} 集，${name}`} aria-pressed={active} variant={active?'contained':'outlined'} disabled={disabled} onClick={onClick}>
    <span className="episode-number" aria-hidden="true">{badge}</span>
    <span className="episode-name">{label}</span>
  </Button>;
}
