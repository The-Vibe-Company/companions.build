import { useId } from "react";
import { cn } from "@/lib/utils";

export interface CompanionAvatarValue {
  shape: number;
  color: number;
  face: number;
}

export const DEFAULT_AVATAR: CompanionAvatarValue = { shape: 1, color: 2, face: 0 };

export const AVATAR_COLORS = [
  "oklch(0.24 0.015 70)", "oklch(0.48 0.09 52)", "oklch(0.61 0.20 25)",
  "oklch(0.72 0.16 55)", "oklch(0.84 0.15 92)", "oklch(0.62 0.15 145)",
  "oklch(0.65 0.12 190)", "oklch(0.59 0.17 252)", "oklch(0.58 0.18 303)",
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

function Face({ face }: { face: number }) {
  const stroke = { stroke: "white", strokeWidth: 7.5, strokeLinecap: "round" as const, fill: "none" };
  if (face === 1) return <><path {...stroke} d="M36 35L40 27M55 35L59 27"/><path {...stroke} strokeWidth="5" d="M35 55Q49 69 64 55"/></>;
  if (face === 2) return <><path {...stroke} d="M34 32H42M55 35L59 27"/><path {...stroke} strokeWidth="5" d="M39 60Q50 67 61 60"/></>;
  if (face === 3) return <><circle cx="39" cy="32" r="5" fill="white"/><circle cx="59" cy="32" r="5" fill="white"/><circle cx="49" cy="59" r="5" fill="none" stroke="white" strokeWidth="4"/></>;
  if (face === 4) return <><path {...stroke} d="M34 34Q39 39 44 34M54 34Q59 39 64 34"/><path {...stroke} strokeWidth="5" d="M43 59H57"/></>;
  return <><path {...stroke} d="M38.5 37.5L42.5 28.5M55.5 37.5L59.5 28.5"/></>;
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
      <Face face={safe.face} />
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
