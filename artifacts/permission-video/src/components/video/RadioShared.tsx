import { motion } from 'framer-motion';
import {
  Mic,
  Radio,
  Volume2,
  Signal,
  Wifi,
  BatteryFull,
  Lock,
  ShieldCheck,
} from 'lucide-react';

export const BRAND_BG = '#0c0a08';
export const GOLD = '#C9A84C';
export const GREEN = '#16a34a';
export const BLUE = '#0284c7';
export const RED = '#dc2626';

// Deterministic pseudo-random peak per bar so the waveform looks organic but
// renders identically every capture pass.
const peak = (i: number) => 35 + (Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.6)) * 60);

export const Waveform = ({
  color = GOLD,
  active = true,
  bars = 26,
  className = '',
}: {
  color?: string;
  active?: boolean;
  bars?: number;
  className?: string;
}) => (
  <div className={`flex items-center justify-center gap-[3px] ${className}`}>
    {Array.from({ length: bars }).map((_, i) => (
      <motion.div
        key={i}
        className="w-[3px] rounded-full"
        style={{ backgroundColor: color }}
        animate={
          active
            ? { height: ['22%', `${peak(i)}%`, '30%', `${peak(i + 3)}%`, '22%'] }
            : { height: '14%' }
        }
        transition={
          active
            ? {
                duration: 0.85 + (i % 5) * 0.12,
                repeat: Infinity,
                ease: 'easeInOut',
                delay: i * 0.025,
              }
            : { duration: 0.3 }
        }
      />
    ))}
  </div>
);

export const StatusBar = () => (
  <div className="flex items-center justify-between px-6 pt-3 pb-1 text-white text-xs font-semibold">
    <span>9:41</span>
    <div className="flex items-center gap-1.5">
      <Signal className="w-3.5 h-3.5" />
      <Wifi className="w-3.5 h-3.5" />
      <BatteryFull className="w-4 h-4" />
    </div>
  </div>
);

export const RadioTopBar = () => (
  <div className="flex items-center gap-2 px-5 py-3 border-b border-white/10">
    <div
      className="w-8 h-8 rounded-lg flex items-center justify-center"
      style={{ backgroundColor: `${GOLD}22`, border: `1px solid ${GOLD}55` }}
    >
      <Radio className="w-4 h-4" style={{ color: GOLD }} />
    </div>
    <div className="leading-tight">
      <p className="text-white font-bold text-sm">SecureOps Radio</p>
      <p className="text-white/40 text-[10px]">Live push-to-talk</p>
    </div>
  </div>
);

export const ChannelChips = ({ activeName }: { activeName: string }) => {
  const chips = ['Dispatch', 'Nexus Site', 'Patrol'];
  return (
    <div className="flex gap-2 px-5 py-3 overflow-hidden">
      {chips.map((c) => {
        const on = c === activeName;
        return (
          <div
            key={c}
            className="px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap flex items-center gap-1.5"
            style={{
              backgroundColor: on ? GOLD : '#ffffff10',
              color: on ? '#1a1206' : '#ffffff99',
              border: on ? 'none' : '1px solid #ffffff1a',
            }}
          >
            {on && <Volume2 className="w-3 h-3" />}
            {c}
          </div>
        );
      })}
    </div>
  );
};

type BannerKind = 'idle' | 'other' | 'transmitting';

export const StatusBanner = ({ kind, name }: { kind: BannerKind; name?: string }) => {
  if (kind === 'idle') {
    return <p className="text-center text-white/40 text-sm py-2">Channel idle</p>;
  }
  const isTx = kind === 'transmitting';
  const accent = isTx ? GREEN : BLUE;
  return (
    <div
      className="flex items-center justify-center gap-2 mx-5 rounded-xl py-2.5 px-4"
      style={{ backgroundColor: `${accent}1a`, border: `1px solid ${accent}44` }}
    >
      {isTx ? (
        <motion.div
          className="w-2.5 h-2.5 rounded-full"
          style={{ backgroundColor: accent }}
          animate={{ opacity: [1, 0.3, 1] }}
          transition={{ duration: 1, repeat: Infinity }}
        />
      ) : (
        <Volume2 className="w-4 h-4" style={{ color: accent }} />
      )}
      <span className="text-sm font-semibold" style={{ color: isTx ? '#4ade80' : '#7dd3fc' }}>
        {isTx ? 'You are transmitting…' : `${name} is transmitting…`}
      </span>
    </div>
  );
};

export const PTTButton = ({
  state,
  pressed = false,
}: {
  state: 'idle' | 'transmitting';
  pressed?: boolean;
}) => {
  const bg = state === 'transmitting' ? GREEN : RED;
  const label = state === 'transmitting' ? 'Release to stop' : 'Hold to talk';
  return (
    <div className="flex flex-col items-center gap-3">
      <motion.div
        className="relative w-32 h-32 rounded-full flex items-center justify-center shadow-2xl"
        style={{ backgroundColor: bg }}
        animate={{ scale: pressed ? 0.95 : state === 'transmitting' ? [1, 0.97, 1] : 1 }}
        transition={
          state === 'transmitting' && !pressed
            ? { duration: 1.2, repeat: Infinity }
            : { type: 'spring', stiffness: 400, damping: 25 }
        }
      >
        {state === 'transmitting' && (
          <motion.div
            className="absolute inset-0 rounded-full"
            style={{ border: `3px solid ${GREEN}` }}
            animate={{ scale: [1, 1.45], opacity: [0.6, 0] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
        <Mic className="w-14 h-14 text-white relative z-10" />
      </motion.div>
      <span className="text-white/90 font-bold text-sm">{label}</span>
    </div>
  );
};

// Ongoing foreground-service notification shown on the lock screen.
export const OngoingNotification = ({
  accent = GOLD,
  title,
  subtitle,
  icon,
  waveformColor,
  pill,
}: {
  accent?: string;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  waveformColor?: string;
  pill: string;
}) => (
  <motion.div
    initial={{ y: 24, opacity: 0 }}
    animate={{ y: 0, opacity: 1 }}
    transition={{ type: 'spring', stiffness: 200, damping: 22, delay: 0.3 }}
    className="w-full rounded-3xl bg-white/10 backdrop-blur-xl border border-white/20 p-4 shadow-2xl"
  >
    <div className="flex items-center gap-2 mb-3">
      <div
        className="w-6 h-6 rounded-lg flex items-center justify-center"
        style={{ backgroundColor: accent }}
      >
        {icon}
      </div>
      <span className="text-white/80 text-xs font-bold tracking-wide">SecureOps Command</span>
      <span
        className="ml-auto text-[9px] font-bold px-2 py-0.5 rounded-full"
        style={{ backgroundColor: `${accent}33`, color: accent }}
      >
        {pill}
      </span>
    </div>
    <p className="text-white font-bold text-sm leading-tight">{title}</p>
    <p className="text-white/55 text-xs mb-3">{subtitle}</p>
    <Waveform color={waveformColor ?? accent} active bars={30} className="h-9" />
  </motion.div>
);

// A lock screen backdrop (time + lock glyph) used for background scenes.
export const LockScreen = ({ children }: { children: React.ReactNode }) => (
  <div className="absolute inset-0 flex flex-col" style={{ backgroundColor: '#050403' }}>
    {/* subtle wallpaper glow */}
    <div
      className="absolute inset-0"
      style={{
        background:
          'radial-gradient(120% 60% at 50% 0%, rgba(201,168,76,0.12), transparent 60%)',
      }}
    />
    <StatusBar />
    <div className="relative z-10 flex flex-col items-center pt-10">
      <Lock className="w-5 h-5 text-white/50 mb-3" />
      <p className="text-white text-6xl font-light tracking-tight tabular-nums">9:41</p>
      <p className="text-white/50 text-sm mt-1">Friday, July 24</p>
    </div>
    <div className="relative z-10 mt-auto px-5 pb-10 w-full">{children}</div>
  </div>
);

// Radio screen chrome shared by channel / listen / transmit scenes.
export const RadioScreen = ({
  channelName,
  siteName,
  banner,
  waveform,
  ptt,
}: {
  channelName: string;
  siteName: string;
  banner: React.ReactNode;
  waveform: React.ReactNode;
  ptt: React.ReactNode;
}) => (
  <div className="absolute inset-0 flex flex-col" style={{ backgroundColor: BRAND_BG }}>
    <StatusBar />
    <RadioTopBar />
    <ChannelChips activeName={channelName} />
    <div className="flex-1 flex flex-col items-center px-5">
      <p className="text-white text-2xl font-extrabold mt-2">{channelName}</p>
      <p className="text-white/40 text-xs mb-4 flex items-center gap-1">
        <ShieldCheck className="w-3 h-3" style={{ color: GOLD }} /> Site: {siteName}
      </p>
      <div className="w-full mb-4">{banner}</div>
      <div className="h-12 w-full flex items-center justify-center mb-4">{waveform}</div>
      <div className="mt-auto mb-10">{ptt}</div>
    </div>
  </div>
);
