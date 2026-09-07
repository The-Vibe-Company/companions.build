import { useId } from "react";
import { cn } from "@/lib/utils";

export interface CompanionAvatarValue {
  shape: number;
  color: number;
  face: number;
}

export const DEFAULT_AVATAR: CompanionAvatarValue = { shape: 1, color: 2, face: 0 };

export const AVATAR_COLORS = [
  "oklch(0.24 0.015 70)", "oklch(0.48 0.09 52)", "oklch(0.70 0.18 30)",
  "oklch(0.72 0.16 55)", "oklch(0.84 0.15 92)", "oklch(0.62 0.15 145)",
  "oklch(0.65 0.12 190)", "oklch(0.67 0.14 280)", "oklch(0.58 0.18 303)",
  "oklch(0.68 0.18 350)", "oklch(0.58 0.02 260)",
];

const SHAPES = [
  <circle key="circle" cx="50" cy="50" r="46" />,
  <path key="blob" d="M52 4C80 1 99 23 94 54C91 84 69 100 37 95C9 91 0 65 6 35C12 11 29 6 52 4Z" />,
  <rect key="squircle" x="4" y="4" width="92" height="92" rx="24" />,
  <rect key="capsule" x="15" y="3" width="70" height="94" rx="35" />,
  <path key="triangle" d="M50 4L97 94H3Z" />,
  <path key="hexagon" d="M27 4H73L97 50L73 96H27L3 50Z" />,
  <path key="flower" d="M50 11C62 0 80 7 79 23C98 20 100 40 89 50C100 62 94 83 78 78C78 98 57 100 49 88C37 100 17 94 22 77C3 78 0 57 12 49C0 36 8 16 24 22C23 5 43 0 50 11Z" />,
  <path key="drop" d="M50 2S93 50 93 70C93 91 74 100 50 100S7 91 7 70C7 48 50 2 50 2Z" />,
];

function Face({ face, dark }: { face: number; dark: boolean }) {
  const ink = "#242622";
  const stroke = { stroke: dark ? "white" : ink, strokeWidth: 3.2, strokeLinecap: "round" as const, fill: "none" };
  const eye = (x: number) => <g key={x}><ellipse cx={x} cy="44" rx="7.5" ry="9" fill="white"/><ellipse cx={x+1.4} cy="45" rx="4.2" ry="5.5" fill={ink}/></g>;
  return <>{face===4 ? <><path {...stroke} d="M29 44Q36 50 43 44M57 44Q64 50 71 44"/></> : <>{eye(36)}{face===2?<path {...stroke} d="M58 44Q65 49 71 43"/>:eye(64)}</>}
    {face===3?<ellipse cx="50" cy="64" rx="4" ry="5" fill={dark ? "white" : ink}/>:face===1?<path d="M42 60Q50 74 59 60Z" fill={dark ? "white" : ink}/>:<path {...stroke} d={face===4?"M44 64H56":"M44 62Q50 68 57 62"}/>}</>;
}

export function CompanionAvatar({
  name,
  avatar = DEFAULT_AVATAR,
  size = 40,
  className,
}: {
  name: string;
  avatar?: CompanionAvatarValue | null;
  size?: number;
  className?: string;
}) {
  const safe = {
    shape: SHAPES[avatar?.shape ?? -1] ? avatar!.shape : DEFAULT_AVATAR.shape,
    color: AVATAR_COLORS[avatar?.color ?? -1] ? avatar!.color : DEFAULT_AVATAR.color,
    face: avatar?.face != null && avatar.face >= 0 && avatar.face <= 4 ? avatar.face : DEFAULT_AVATAR.face,
  };
  return (
    <svg className={cn("character-mark", className)} width={size} height={size} style={{ width: size, height: size }} viewBox="0 0 100 100" role="img" aria-label={`${name}, Companion`}>
      <g fill={AVATAR_COLORS[safe.color]}>{SHAPES[safe.shape]}</g>
      <Face face={safe.face} dark={safe.color === 0 || safe.color === 1} />
    </svg>
  );
}

export function AvatarPicker({ value, onChange }: { value: CompanionAvatarValue; onChange: (avatar: CompanionAvatarValue) => void }) {
  const id = useId();
  return (
    <div className="avatar-picker">
      <div className="avatar-preview"><CompanionAvatar name="Avatar preview" avatar={value} size={88} /></div>
      <fieldset><legend>Shape</legend><div className="avatar-options avatar-options--shapes">
        {SHAPES.map((_, shape) => <button key={shape} type="button" aria-label={`Shape ${shape + 1}`} aria-pressed={value.shape === shape} onClick={() => onChange({ ...value, shape })}><CompanionAvatar name={`Shape ${shape + 1}`} avatar={{ ...value, shape, face: 0 }} size={40} /></button>)}
      </div></fieldset>
      <fieldset><legend>Color</legend><div className="avatar-options avatar-options--colors">
        {AVATAR_COLORS.map((color, index) => <button key={color} type="button" aria-label={`Color ${index + 1}`} aria-pressed={value.color === index} onClick={() => onChange({ ...value, color: index })}><span style={{ background: color }} /></button>)}
      </div></fieldset>
      <fieldset><legend>Face</legend><div className="avatar-options avatar-options--faces">
        {[0, 1, 2, 3, 4].map((face) => <button key={`${id}-${face}`} type="button" aria-label={`Face ${face + 1}`} aria-pressed={value.face === face} onClick={() => onChange({ ...value, face })}><CompanionAvatar name={`Face ${face + 1}`} avatar={{ ...value, face }} size={40} /></button>)}
      </div></fieldset>
    </div>
  );
}
