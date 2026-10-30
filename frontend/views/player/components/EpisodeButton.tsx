import { Button } from '@mui/material';

/** 文件名最多显示六个字符（含省略号）；悬浮和辅助阅读保留完整文件名，不生成选集序号。 */
export function EpisodeButton({name,active,disabled,onClick}: {name:string;active:boolean;disabled:boolean;onClick:()=>void}) {
  const characters = Array.from(name);
  const label = characters.length > 6 ? characters.slice(0, 5).join('') + '…' : name;
  return <Button size="small" className="episode-tile" title={name} aria-label={name} aria-pressed={active} variant={active?'contained':'outlined'} disabled={disabled} onClick={onClick}>
    <span className="episode-name">{label}</span>
  </Button>;
}
