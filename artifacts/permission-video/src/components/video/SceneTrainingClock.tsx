import { motion } from 'framer-motion';
import { Pointer, springSmooth } from './Shared';
import { TopBar, BottomTab } from './TrainingShared';
import { Navigation } from 'lucide-react';
import { useEffect, useState } from 'react';

export const SceneTrainingClock = () => {
  const [phase, setPhase] = useState<'off'|'verifying'|'on'>('off');
  const [pointer, setPointer] = useState({ x: '50%', y: '80%', active: false, show: false });
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    let timers = [
      setTimeout(() => setPointer({ x: '50%', y: '70%', active: false, show: true }), 1000),
      setTimeout(() => setPointer(p => ({ ...p, active: true })), 1800),
      setTimeout(() => {
        setPointer(p => ({ ...p, active: false, show: false }));
        setPhase('verifying');
      }, 2000),
      setTimeout(() => setPhase('on'), 4000),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (phase === 'on') {
      const interval = setInterval(() => setSeconds(s => s + 1), 1000);
      return () => clearInterval(interval);
    }
    return undefined;
  }, [phase]);

  const formatTime = (secs: number) => {
    const h = Math.floor(secs / 3600).toString().padStart(2, '0');
    const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  };

  return (
    <motion.div className="absolute inset-0 bg-[#0c0a08] flex flex-col"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5 }}
    >
      <TopBar title="Clock In/Out" />
      
      <div className="flex-1 flex flex-col items-center pt-8 px-6 relative">
        <motion.div 
          className="relative w-64 h-64 flex items-center justify-center mb-8"
          animate={{ scale: phase === 'on' ? 1.05 : 1 }}
          transition={springSmooth}
        >
          {/* Ring */}
          <motion.svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="4" />
            <motion.circle 
              cx="50" cy="50" r="46" fill="none" 
              stroke={phase === 'on' ? '#16a34a' : 'transparent'} 
              strokeWidth="4" 
              strokeDasharray="289"
              initial={{ strokeDashoffset: 289 }}
              animate={{ strokeDashoffset: phase === 'on' ? 0 : 289 }}
              transition={{ duration: 1.5, ease: 'easeOut' }}
              strokeLinecap="round"
            />
          </motion.svg>
          
          <div className="text-center">
            {phase === 'off' && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <div className="text-white/40 font-bold uppercase tracking-widest text-sm mb-2">Status</div>
                <div className="text-white text-3xl font-bold">OFF DUTY</div>
              </motion.div>
            )}
            {phase === 'verifying' && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center">
                <motion.div
                  className="mb-2"
                  animate={{ opacity: [1, 0.4, 1] }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
                >
                  <Navigation className="w-8 h-8 text-[#0284c7]" />
                </motion.div>
                <div className="text-[#0284c7] font-semibold text-sm">Verifying Location...</div>
              </motion.div>
            )}
            {phase === 'on' && (
              <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}>
                <div className="text-[#4ade80] font-bold uppercase tracking-widest text-sm mb-1">ON DUTY</div>
                <div className="text-white text-4xl font-mono tabular-nums tracking-tight">{formatTime(seconds)}</div>
                <div className="text-white/50 text-xs mt-2">Nexus Industrial Park</div>
              </motion.div>
            )}
          </div>
        </motion.div>

        {phase === 'off' && (
          <motion.div className="w-full" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-[#16a34a] text-white py-4 rounded-xl font-bold text-center text-lg shadow-[0_0_30px_rgba(22,163,74,0.3)]">
              CLOCK IN
            </div>
            <div className="mt-6 text-center text-white/40 text-xs underline decoration-white/20 underline-offset-4">
              Location not working? Pick your shift
            </div>
          </motion.div>
        )}

        {phase === 'on' && (
          <motion.div className="w-full mt-auto mb-28" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <div className="bg-[#dc2626] text-white py-4 rounded-xl font-bold text-center text-lg shadow-[0_0_30px_rgba(220,38,38,0.3)]">
              CLOCK OUT
            </div>
          </motion.div>
        )}
      </div>

      <Pointer {...pointer} />
      <BottomTab active="clock" />
    </motion.div>
  );
};
