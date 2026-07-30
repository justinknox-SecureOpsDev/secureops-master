import { motion } from 'framer-motion';
import { CheckCircle2, Navigation, Clock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { springSmooth, springSnappy, springBouncy } from './Shared';

export const Scene3ClockIn = () => {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setSeconds(s => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatTime = (secs: number) => {
    const h = Math.floor(secs / 3600).toString().padStart(2, '0');
    const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  };

  return (
    <motion.div 
      className="absolute inset-0 bg-[#0c0a08] flex flex-col items-center justify-center p-6 z-30"
      initial={{ opacity: 0, scale: 1.05 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.8, ease: "easeOut" }}
    >
      {/* Dynamic Background Effect */}
      <motion.div 
        className="absolute inset-0 overflow-hidden"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5, duration: 2 }}
      >
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[80vw] h-[80vw] bg-[#C9A84C]/5 rounded-full blur-[60px]" />
      </motion.div>

      <motion.div
        initial={{ scale: 0, rotate: -45 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ delay: 0.4, ...springBouncy }}
        className="relative z-10"
      >
        <div className="w-24 h-24 bg-green-500/20 rounded-full flex items-center justify-center border border-green-500/30 mb-8">
          <CheckCircle2 className="w-12 h-12 text-green-400" />
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.7, ...springSnappy }}
        className="text-center relative z-10 w-full"
      >
        <h1 className="text-3xl font-bold text-white mb-2">Clocked In</h1>
        <p className="text-zinc-400 mb-8">Nexus Industrial Park</p>

        {/* Timer Card */}
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-6 w-full mb-6 backdrop-blur-md">
          <div className="flex justify-center items-center gap-3 mb-2">
            <Clock className="w-5 h-5 text-[#C9A84C]" />
            <span className="text-sm font-medium uppercase tracking-wider text-[#C9A84C]">Active Shift</span>
          </div>
          <div className="text-4xl font-mono text-white tabular-nums tracking-tight">
            {formatTime(seconds)}
          </div>
        </div>

        {/* Location Indicator */}
        <div className="flex flex-col items-center gap-3 bg-blue-900/10 border border-blue-900/30 rounded-2xl p-4 w-full">
          <div className="relative">
            <motion.div
              animate={{ scale: [1, 1.5, 1], opacity: [1, 0, 1] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
              className="absolute inset-0 bg-blue-500 rounded-full"
            />
            <Navigation className="w-5 h-5 text-blue-400 fill-blue-400 relative z-10" />
          </div>
          <p className="text-sm text-blue-300 font-medium">Location shared while the app is open</p>
        </div>
      </motion.div>

      {/* Slide to Clock Out Button mock */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1, ...springSmooth }}
        className="absolute bottom-12 left-6 right-6"
      >
        <div className="w-full bg-zinc-900 border border-zinc-800 rounded-full h-14 flex items-center px-2">
          <div className="w-10 h-10 bg-red-500/20 text-red-500 rounded-full flex items-center justify-center">
            <div className="w-3 h-3 rounded-full bg-red-500" />
          </div>
          <span className="flex-1 text-center pr-10 text-zinc-500 font-medium">Slide to clock out</span>
        </div>
      </motion.div>
    </motion.div>
  );
};