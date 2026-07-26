import { AnimatePresence, motion } from 'framer-motion';
import { Shield, MapPin, CheckCircle, Clock } from 'lucide-react';
import { useEffect, useState } from 'react';

// Common Animations
export const springSnappy = { type: 'spring' as const, stiffness: 400, damping: 30 };
export const springBouncy = { type: 'spring' as const, stiffness: 300, damping: 15 };
export const springSmooth = { type: 'spring' as const, stiffness: 120, damping: 25 };

// Finger pointer simulation
export const Pointer = ({ x, y, active, show }: { x: number | string, y: number | string, active: boolean, show: boolean }) => (
  <AnimatePresence>
    {show && (
      <motion.div
        initial={{ opacity: 0, scale: 1.5, left: x, top: y }}
        animate={{ opacity: 1, scale: 1, left: x, top: y }}
        exit={{ opacity: 0, scale: 0.8 }}
        transition={springSmooth}
        className="absolute z-50 pointer-events-none"
        style={{ x: '-50%', y: '-50%' }}
      >
        <motion.div
          animate={{ scale: active ? 0.8 : 1 }}
          className="w-12 h-12 bg-white/30 rounded-full flex items-center justify-center backdrop-blur-sm border border-white/50 shadow-lg"
        >
          <motion.div
            animate={{ scale: active ? 1.5 : 0, opacity: active ? 1 : 0 }}
            className="w-full h-full bg-white/40 rounded-full"
          />
        </motion.div>
      </motion.div>
    )}
  </AnimatePresence>
);

export const PhoneBezel = ({ children }: { children: React.ReactNode }) => (
  <div className="relative w-[45vh] h-[90vh] rounded-[3rem] border-[12px] border-zinc-900 bg-black shadow-2xl shadow-black/50 overflow-hidden ring-4 ring-zinc-800">
    {/* Camera Notch */}
    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-7 bg-zinc-900 rounded-b-3xl z-40 flex justify-center items-center">
      <div className="w-3 h-3 rounded-full bg-black/80 border border-zinc-800" />
    </div>
    
    {/* Screen Content */}
    <div className="relative w-full h-full bg-brand-bg text-white overflow-hidden font-display">
      {children}
    </div>
  </div>
);