/**
 * The built-in face catalogue (founder decision, 2026-07-29).
 *
 * People work better with a face than with a list row — but generating portraits per
 * user would bill Bedrock tokens before the first chat, which is exactly the wrong
 * first impression for a product whose money story is "free until it runs". So the
 * faces ship WITH the app: fifty friendly illustrated heads, drawn as code, picked
 * from a grid. Zero tokens, works offline, and every face is ours forever.
 *
 * Swappable by design: an agent stores only an id ("av-17"). If the catalogue is ever
 * replaced with commissioned or AI-generated artwork, the new images keep the same ids
 * and every existing agent gets its new face without a data change.
 */

const COUNT = 50;

export const AVATAR_IDS = Array.from({ length: COUNT }, (_, i) => `av-${String(i + 1).padStart(2, "0")}`);

export function isAvatarId(v: unknown): v is string {
  return typeof v === "string" && AVATAR_IDS.includes(v);
}

/**
 * Each face is a deterministic mix of independent traits, cycled at co-prime rates so
 * neighbouring faces never look like siblings. The golden angle spreads the hues.
 */
function traits(n: number) {
  return {
    hue: Math.round((n * 137.508) % 360),
    head: n % 5,
    eyes: n % 4,
    mouth: n % 3,
    extra: n % 7,
  };
}

function Face(props: { n: number; size: number }) {
  const t = traits(props.n);
  const bg = `hsl(${t.hue} 60% 82%)`;
  const skin = `hsl(${t.hue} 45% 95%)`;
  const ink = `hsl(${t.hue} 45% 28%)`;
  const cheek = `hsl(${(t.hue + 330) % 360} 70% 80%)`;

  const head = [
    <circle key="h" cx="32" cy="34" r="19" fill={skin} stroke={ink} strokeWidth="2" />,
    <rect key="h" x="14" y="16" width="36" height="36" rx="9" fill={skin} stroke={ink} strokeWidth="2" />,
    <rect key="h" x="15" y="15" width="34" height="38" rx="17" fill={skin} stroke={ink} strokeWidth="2" />,
    <ellipse key="h" cx="32" cy="34" rx="17" ry="20" fill={skin} stroke={ink} strokeWidth="2" />,
    <rect key="h" x="12" y="19" width="40" height="31" rx="12" fill={skin} stroke={ink} strokeWidth="2" />,
  ][t.head];

  const eye = (cx: number, wink: boolean) =>
    wink ? (
      <path d={`M ${cx - 3} 31 q 3 3 6 0`} fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
    ) : (
      [
        <circle cx={cx} cy="31" r="2.6" fill={ink} />,
        <path d={`M ${cx - 3} 32 q 3 -4 6 0`} fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />,
        <ellipse cx={cx} cy="31" rx="2.4" ry="3.4" fill={ink} />,
        <circle cx={cx} cy="31" r="2.6" fill={ink} />,
      ][t.eyes]
    );

  const mouth = [
    <path d="M 26 41 q 6 6 12 0" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />,
    <ellipse cx="32" cy="42.5" rx="3.6" ry="2.6" fill={ink} />,
    <path d="M 27 42 q 5 3 10 0" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />,
  ][t.mouth];

  const extra = [
    // antenna
    <g key="x">
      <line x1="32" y1="15" x2="32" y2="8" stroke={ink} strokeWidth="2" />
      <circle cx="32" cy="6.5" r="2.8" fill={ink} />
    </g>,
    // round ears
    <g key="x">
      <circle cx="12.5" cy="34" r="4" fill={skin} stroke={ink} strokeWidth="2" />
      <circle cx="51.5" cy="34" r="4" fill={skin} stroke={ink} strokeWidth="2" />
    </g>,
    // plain
    <g key="x" />,
    // hair tuft
    <path key="x" d="M 26 15 q 6 -7 12 0" fill="none" stroke={ink} strokeWidth="2.5" strokeLinecap="round" />,
    // headset
    <g key="x">
      <path d="M 14 32 q 0 -19 18 -19 q 18 0 18 19" fill="none" stroke={ink} strokeWidth="2.5" />
      <circle cx="14" cy="34" r="3.2" fill={ink} />
      <circle cx="50" cy="34" r="3.2" fill={ink} />
    </g>,
    // blush
    <g key="x">
      <circle cx="21.5" cy="37.5" r="2.6" fill={cheek} />
      <circle cx="42.5" cy="37.5" r="2.6" fill={cheek} />
    </g>,
    // brows
    <g key="x">
      <path d="M 21.5 26 q 3 -2.5 6 0" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
      <path d="M 36.5 26 q 3 -2.5 6 0" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" />
    </g>,
  ][t.extra];

  return (
    <svg viewBox="0 0 64 64" width={props.size} height={props.size} aria-hidden="true">
      <circle cx="32" cy="32" r="31" fill={bg} />
      {head}
      {eye(25.5, false)}
      {eye(38.5, t.eyes === 3)}
      {mouth}
      {extra}
    </svg>
  );
}

/**
 * An agent's face, at any size. An agent without a chosen face gets its initials on a
 * colour derived from its name — stable, and never a broken-image square.
 */
export function Avatar(props: { id?: string; name: string; size?: number }) {
  const size = props.size ?? 44;
  const idx = props.id ? AVATAR_IDS.indexOf(props.id) : -1;
  if (idx >= 0) {
    return (
      <span className="avatar" style={{ width: size, height: size }}>
        <Face n={idx + 1} size={size} />
      </span>
    );
  }
  let h = 0;
  for (const c of props.name) h = (h * 31 + c.charCodeAt(0)) % 360;
  const initials = props.name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
  return (
    <span
      className="avatar avatar-initials"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: `hsl(${h} 55% 82%)`,
        color: `hsl(${h} 45% 28%)`,
      }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

/** The catalogue as a picker: every face visible, one tap to choose, none required. */
export function AvatarPicker(props: { value?: string; name: string; onPick: (id: string | undefined) => void }) {
  return (
    <div className="avatar-picker" role="radiogroup" aria-label="Choose a face">
      <button
        type="button"
        className={`avatar-choice${!props.value ? " picked" : ""}`}
        role="radio"
        aria-checked={!props.value}
        title="No face — initials instead"
        onClick={() => props.onPick(undefined)}
      >
        <Avatar name={props.name || "?"} size={34} />
      </button>
      {AVATAR_IDS.map((id) => (
        <button
          type="button"
          key={id}
          className={`avatar-choice${props.value === id ? " picked" : ""}`}
          role="radio"
          aria-checked={props.value === id}
          title={id}
          onClick={() => props.onPick(id)}
        >
          <Avatar id={id} name={props.name || "?"} size={34} />
        </button>
      ))}
    </div>
  );
}
